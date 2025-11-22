import type { Agent } from "@xmtp/agent-sdk";
import type { Group } from "@xmtp/agent-sdk";
import type { Dm } from "@xmtp/agent-sdk";
import {
  GameState,
  Role,
  type Game,
  type Player,
  type Task,
  type VoteResult,
} from "./types.js";
import { generateTask, validateTaskAnswer } from "./tasks.js";
import {
  MAX_PLAYERS,
  MAX_ROUNDS,
  MIN_PLAYERS_TO_START,
  KILL_COOLDOWN_MS,
  KILL_SUCCESS_CHANCE,
  MAX_KILL_ATTEMPTS,
  JOIN_WINDOW_DURATION_MS,
  KILL_COOLDOWN_SECONDS,
} from "./config/gameConfig.js";

export class GameManager {
  private game: Game;
  private agent: Agent;

  constructor(agent: Agent) {
    this.agent = agent;
    this.game = {
      state: GameState.IDLE,
      lobbyGroupId: null,
      originalGroupId: null,
      players: new Map(),
      round: 0,
      startTime: null,
      joinDeadline: null,
      currentPhaseDeadline: null,
      impostorInboxId: null,
      eliminatedPlayers: new Set(),
      killCooldown: KILL_COOLDOWN_MS,
      killSuccessChance: KILL_SUCCESS_CHANCE,
      maxKillAttempts: MAX_KILL_ATTEMPTS,
      taskAssignments: new Map(),
    };
  }

  getGame(): Game {
    return this.game;
  }

  getState(): GameState {
    return this.game.state;
  }

  getPlayer(inboxId: string): Player | undefined {
    return this.game.players.get(inboxId);
  }

  getAlivePlayers(): Player[] {
    return Array.from(this.game.players.values()).filter((p) => p.isAlive);
  }

  async createLobby(originalGroupId: string): Promise<string> {
    if (this.game.state !== GameState.IDLE) {
      throw new Error("Game already in progress");
    }

    // Get the agent's inbox ID to include in the group
    const agentInboxId = this.agent.client.inboxId;

    // Create unique group name with timestamp to ensure uniqueness
    const timestamp = Date.now();
    const uniqueId = timestamp.toString().slice(-6); // Last 6 digits of timestamp
    const groupName = `🟥 MAFIA LOBBY #${uniqueId}`;

    // Create group with just the agent initially (agent must be in group)
    const group = await this.agent.client.conversations.newGroup([agentInboxId], {
      groupName: groupName,
      groupDescription: "A text-based social deduction game",
    });

    this.game.state = GameState.LOBBY_CREATED;
    this.game.lobbyGroupId = group.id;
    this.game.originalGroupId = originalGroupId;
    this.game.startTime = Date.now();
    this.game.joinDeadline = Date.now() + JOIN_WINDOW_DURATION_MS;

    return group.id;
  }

  async addPlayer(inboxId: string, username: string): Promise<{ success: boolean; removedPlayer?: Player }> {
    if (this.game.state !== GameState.LOBBY_CREATED && 
        this.game.state !== GameState.WAITING_FOR_PLAYERS) {
      return { success: false };
    }

    if (this.game.players.has(inboxId)) {
      return { success: false }; // Already joined
    }

    const now = Date.now();
    if (this.game.joinDeadline && now > this.game.joinDeadline) {
      return { success: false }; // Join window closed
    }

    // If lobby is full, remove the last player
    // IMPORTANT: Never remove the agent from the group
    let removedPlayer: Player | undefined;
    const agentInboxId = this.agent.client.inboxId;
    
    if (this.game.players.size >= MAX_PLAYERS) {
      // Get the last player (most recently added) from the Map
      // Since Maps maintain insertion order, we can get the last entry
      // Skip the agent if it's the last entry (shouldn't happen, but safety check)
      const playersArray = Array.from(this.game.players.entries());
      
      // Find the last player that is NOT the agent
      let lastEntry: [string, Player] | null = null;
      for (let i = playersArray.length - 1; i >= 0; i--) {
        const entry = playersArray[i];
        if (entry[0].toLowerCase() !== agentInboxId.toLowerCase()) {
          lastEntry = entry;
          break;
        }
      }
      
      if (lastEntry) {
        const [lastInboxId, lastPlayer] = lastEntry;
        removedPlayer = lastPlayer;
        
        // Remove from game
        this.game.players.delete(lastInboxId);
        
        // Remove from group (but never remove the agent)
        if (this.game.lobbyGroupId && lastInboxId.toLowerCase() !== agentInboxId.toLowerCase()) {
          try {
            const group = await this.agent.client.conversations.getConversationById(
              this.game.lobbyGroupId
            );
            if (group && "removeMembers" in group) {
              await (group as any).removeMembers([lastInboxId]);
            }
          } catch (error) {
            console.error(`Error removing player ${lastInboxId} from group:`, error);
          }
        }
      }
    }

    const player: Player = {
      inboxId,
      username,
      role: null,
      isAlive: true,
      completedTasks: 0,
      killAttempts: 0,
      lastKillAttempt: null,
      voted: false,
      voteTarget: null,
    };

    this.game.players.set(inboxId, player);
    this.game.state = GameState.WAITING_FOR_PLAYERS;

    // Add player to group
    if (this.game.lobbyGroupId) {
      const group = await this.agent.client.conversations.getConversationById(
        this.game.lobbyGroupId
      );
      if (group && "addMembers" in group) {
        await (group as Group).addMembers([inboxId]);
      }
    }

    return { success: true, removedPlayer };
  }

  canStartGame(): boolean {
    const now = Date.now();
    const deadlinePassed = this.game.joinDeadline && now > this.game.joinDeadline;
    const isFull = this.game.players.size >= 6;
    
    return (
      this.game.state === GameState.WAITING_FOR_PLAYERS &&
      (deadlinePassed || isFull) &&
      this.game.players.size >= MIN_PLAYERS_TO_START
    );
  }

  async assignRoles(): Promise<void> {
    if (this.game.state !== GameState.WAITING_FOR_PLAYERS || !this.canStartGame()) {
      throw new Error("Cannot assign roles at this time");
    }

    const playerArray = Array.from(this.game.players.values());
    
    // Randomly select impostor
    const impostorIndex = Math.floor(Math.random() * playerArray.length);
    const impostor = playerArray[impostorIndex];
    
    impostor.role = Role.IMPOSTOR;
    this.game.impostorInboxId = impostor.inboxId;

    // Assign crew to everyone else
    for (const player of playerArray) {
      if (player.inboxId !== impostor.inboxId) {
        player.role = Role.CREW;
      }
    }

    this.game.state = GameState.ASSIGN_ROLES;

    // Send role DMs
    await this.sendRoleDMs();
  }

  private async sendRoleDMs(): Promise<void> {
    for (const player of this.game.players.values()) {
      try {
        const dm = await this.agent.client.conversations.newDm(player.inboxId);
        
        if (player.role === Role.IMPOSTOR) {
          await dm.send(
            `[Private Message]\n\n` +
            `You are the 🔥 MAFIA.\n\n` +
            `You can attempt kills using:\n` +
            `@mafia kill <username>\n\n` +
            `Success chance: 50%\n` +
            `Max attempts per round: ${MAX_KILL_ATTEMPTS}\n` +
            `Cooldown: ${KILL_COOLDOWN_SECONDS} seconds per attempt`
          );
        } else {
          await dm.send(
            `[Private Message]\n\n` +
            `You are a ✅ TOWN MEMBER.\n\n` +
            `Complete tasks using:\n` +
            `@mafia /task <value>\n\n` +
            `Your goal is to identify and vote out the mafia!`
          );
        }
      } catch (error) {
        console.error(`Failed to send DM to ${player.username}:`, error);
      }
    }
  }

  async startRound(round: number): Promise<void> {
    if (round < 1 || round > MAX_ROUNDS) {
      throw new Error(`Invalid round number. Must be between 1 and ${MAX_ROUNDS}`);
    }

    this.game.round = round;
    this.game.state = this.getStateForRoundPhase(round, "TASKS");

    // Reset player state for new round
    for (const player of this.game.players.values()) {
      if (player.isAlive) {
        player.killAttempts = 0;
        player.lastKillAttempt = null;
        player.voted = false;
        player.voteTarget = null;
        
        // Assign tasks to all players (including mafia)
        // Mafia gets a fake task that they can't complete, but it looks the same
        const task = generateTask();
        this.game.taskAssignments.set(player.inboxId, task);
      }
    }
  }

  private getStateForRoundPhase(
    round: number,
    phase: "TASKS" | "KILL" | "DISCUSSION" | "VOTING"
  ): GameState {
    const stateMap: Record<number, Record<string, GameState>> = {
      1: {
        TASKS: GameState.ROUND_1_TASKS,
        KILL: GameState.ROUND_1_KILL,
        DISCUSSION: GameState.ROUND_1_DISCUSSION,
        VOTING: GameState.ROUND_1_VOTING,
      },
      2: {
        TASKS: GameState.ROUND_2_TASKS,
        KILL: GameState.ROUND_2_KILL,
        DISCUSSION: GameState.ROUND_2_DISCUSSION,
        VOTING: GameState.ROUND_2_VOTING,
      },
      3: {
        TASKS: GameState.ROUND_3_TASKS,
        KILL: GameState.ROUND_3_KILL,
        DISCUSSION: GameState.ROUND_3_DISCUSSION,
        VOTING: GameState.ROUND_3_VOTING,
      },
    };

    return stateMap[round]?.[phase] || GameState.IDLE;
  }

  async completeTask(inboxId: string, answer: string): Promise<boolean> {
    const player = this.game.players.get(inboxId);
    if (!player || !player.isAlive) {
      return false;
    }

    // Mafia cannot complete tasks (they get fake tasks but can't actually complete them)
    if (player.role === Role.IMPOSTOR) {
      return false;
    }

    // Check if we're in a task phase
    const isTaskPhase =
      this.game.state === GameState.ROUND_1_TASKS ||
      this.game.state === GameState.ROUND_2_TASKS ||
      this.game.state === GameState.ROUND_3_TASKS;

    if (!isTaskPhase) {
      return false;
    }

    const task = this.game.taskAssignments.get(inboxId);
    if (!task || task.completed) {
      return false;
    }

    // Trim and normalize the answer before validation
    const normalizedAnswer = answer.trim();
    const isCorrect = validateTaskAnswer(task, normalizedAnswer);
    if (isCorrect) {
      task.completed = true;
      player.completedTasks++;
      return true;
    }

    return false;
  }

  async attemptKill(
    impostorInboxId: string,
    targetIdentifier: string
  ): Promise<{ success: boolean; message: string }> {
    const impostor = this.game.players.get(impostorInboxId);
    if (!impostor || !impostor.isAlive || impostor.role !== Role.IMPOSTOR) {
      return {
        success: false,
        message: "Only the mafia can attempt kills.",
      };
    }

    // Check if we're in a kill phase
    const isKillPhase =
      this.game.state === GameState.ROUND_1_KILL ||
      this.game.state === GameState.ROUND_2_KILL ||
      this.game.state === GameState.ROUND_3_KILL;

    if (!isKillPhase) {
      return {
        success: false,
        message: "It's not the kill phase yet.",
      };
    }

    // Check if targetIdentifier looks like an address (starts with 0x and is 42 chars)
    const isAddress = /^0x[a-fA-F0-9]{40}$/.test(targetIdentifier.trim());
    
    let target: Player | undefined;
    
    if (isAddress) {
      // Find by address - need to get addresses for all players
      const lobbyId = this.game.lobbyGroupId;
      if (lobbyId) {
        try {
          const group = await this.agent.client.conversations.getConversationById(lobbyId);
          if (group && "members" in group) {
            const members = await group.members();
            const targetMember = members.find(
              (m: any) => 
                m.accountIdentifiers?.[0]?.identifier?.toLowerCase() === targetIdentifier.trim().toLowerCase()
            );
            
            if (targetMember) {
              target = Array.from(this.game.players.values()).find(
                (p) => p.inboxId.toLowerCase() === targetMember.inboxId.toLowerCase() && p.isAlive
              );
            }
          }
        } catch (error) {
          console.error("Error finding player by address:", error);
        }
      }
    }
    
    // If not found by address, try by username
    if (!target) {
      target = Array.from(this.game.players.values()).find(
        (p) => p.username.toLowerCase() === targetIdentifier.toLowerCase() && p.isAlive
      );
    }

    if (!target) {
      return {
        success: false,
        message: `Player "${targetIdentifier}" not found or already eliminated.`,
      };
    }

    if (target.inboxId === impostorInboxId) {
      return {
        success: false,
        message: "You cannot kill yourself.",
      };
    }

    // Check cooldown
    const now = Date.now();
    if (
      impostor.lastKillAttempt &&
      now - impostor.lastKillAttempt < this.game.killCooldown
    ) {
      const remainingCooldown = Math.ceil(
        (this.game.killCooldown - (now - impostor.lastKillAttempt)) / 1000
      );
      return {
        success: false,
        message: `Kill attempt on cooldown. Wait ${remainingCooldown} more seconds.`,
      };
    }

    // Check attempts limit
    if (impostor.killAttempts >= this.game.maxKillAttempts) {
      return {
        success: false,
        message: "Maximum kill attempts reached for this round.",
      };
    }

    // Attempt kill
    impostor.killAttempts++;
    impostor.lastKillAttempt = now;

    const success = Math.random() < this.game.killSuccessChance;

    if (success) {
      target.isAlive = false;
      this.game.eliminatedPlayers.add(target.inboxId);
      return {
        success: true,
        message: `Kill SUCCESS!\n\n@${target.username} is eliminated.`,
      };
    } else {
      const attemptsLeft = this.game.maxKillAttempts - impostor.killAttempts;
      return {
        success: false,
        message: `Kill FAILED (${(KILL_SUCCESS_CHANCE * 100).toFixed(0)}% chance).\n\nCooldown: ${KILL_COOLDOWN_SECONDS} seconds.\nAttempts left: ${attemptsLeft}.`,
      };
    }
  }

  async castVote(voterInboxId: string, targetUsername: string): Promise<boolean> {
    const voter = this.game.players.get(voterInboxId);
    if (!voter || !voter.isAlive) {
      return false;
    }

    // Check if we're in voting phase
    const isVotingPhase =
      this.game.state === GameState.ROUND_1_VOTING ||
      this.game.state === GameState.ROUND_2_VOTING ||
      this.game.state === GameState.ROUND_3_VOTING;

    if (!isVotingPhase) {
      return false;
    }

    if (voter.voted) {
      return false; // Already voted
    }

    const target = Array.from(this.game.players.values()).find(
      (p) => p.username.toLowerCase() === targetUsername.toLowerCase()
    );

    if (!target) {
      return false;
    }

    voter.voted = true;
    voter.voteTarget = target.inboxId;
    return true;
  }

  getVoteResults(): VoteResult[] {
    const voteCounts = new Map<string, number>();

    for (const player of this.game.players.values()) {
      if (player.isAlive && player.voted && player.voteTarget) {
        const count = voteCounts.get(player.voteTarget) || 0;
        voteCounts.set(player.voteTarget, count + 1);
      }
    }

    return Array.from(voteCounts.entries())
      .map(([target, votes]) => ({
        target,
        votes,
      }))
      .sort((a, b) => b.votes - a.votes);
  }

  async eliminatePlayer(inboxId: string): Promise<void> {
    const player = this.game.players.get(inboxId);
    if (!player) {
      return;
    }

    player.isAlive = false;
    this.game.eliminatedPlayers.add(inboxId);
  }

  checkWinCondition(): { gameEnded: boolean; winner: "CREW" | "IMPOSTOR" | null } {
    const impostor = this.game.players.get(this.game.impostorInboxId || "");
    
    if (!impostor || !impostor.isAlive) {
      // Impostor eliminated - Crew wins
      return { gameEnded: true, winner: "CREW" };
    }

    if (this.game.round === MAX_ROUNDS) {
      // Check if we just finished round 3 voting
      const isAfterRound3Voting =
        this.game.state === GameState.ROUND_3_VOTING ||
        this.game.state === GameState.GAME_END;

      if (isAfterRound3Voting && impostor.isAlive) {
        // Impostor survived all 3 rounds - Impostor wins
        return { gameEnded: true, winner: "IMPOSTOR" };
      }
    }

    return { gameEnded: false, winner: null };
  }

  async advancePhase(): Promise<void> {
    const state = this.game.state;

    // Task phases -> Kill phases
    if (state === GameState.ROUND_1_TASKS) {
      this.game.state = GameState.ROUND_1_KILL;
    } else if (state === GameState.ROUND_2_TASKS) {
      this.game.state = GameState.ROUND_2_KILL;
    } else if (state === GameState.ROUND_3_TASKS) {
      this.game.state = GameState.ROUND_3_KILL;
    }
    // Kill phases -> Discussion phases
    else if (state === GameState.ROUND_1_KILL) {
      this.game.state = GameState.ROUND_1_DISCUSSION;
    } else if (state === GameState.ROUND_2_KILL) {
      this.game.state = GameState.ROUND_2_DISCUSSION;
    } else if (state === GameState.ROUND_3_KILL) {
      this.game.state = GameState.ROUND_3_DISCUSSION;
    }
    // Discussion phases -> Voting phases
    else if (state === GameState.ROUND_1_DISCUSSION) {
      this.game.state = GameState.ROUND_1_VOTING;
    } else if (state === GameState.ROUND_2_DISCUSSION) {
      this.game.state = GameState.ROUND_2_VOTING;
    } else if (state === GameState.ROUND_3_DISCUSSION) {
      this.game.state = GameState.ROUND_3_VOTING;
    }
    // Voting phases -> Next round or game end
    else if (state === GameState.ROUND_1_VOTING) {
      await this.startRound(2);
    } else if (state === GameState.ROUND_2_VOTING) {
      await this.startRound(3);
    } else if (state === GameState.ROUND_3_VOTING) {
      this.game.state = GameState.GAME_END;
    }
  }

  async cleanup(): Promise<void> {
    this.game = {
      state: GameState.IDLE,
      lobbyGroupId: null,
      originalGroupId: null,
      players: new Map(),
      round: 0,
      startTime: null,
      joinDeadline: null,
      currentPhaseDeadline: null,
      impostorInboxId: null,
      eliminatedPlayers: new Set(),
      killCooldown: KILL_COOLDOWN_MS,
      killSuccessChance: KILL_SUCCESS_CHANCE,
      maxKillAttempts: MAX_KILL_ATTEMPTS,
      taskAssignments: new Map(),
    };
  }

  getPlayerByUsername(username: string): Player | undefined {
    return Array.from(this.game.players.values()).find(
      (p) => p.username.toLowerCase() === username.toLowerCase()
    );
  }

  getAlivePlayerUsernames(): string[] {
    return this.getAlivePlayers().map((p) => p.username);
  }

  getTaskForPlayer(inboxId: string): Task | undefined {
    return this.game.taskAssignments.get(inboxId);
  }
}

