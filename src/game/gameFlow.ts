import type { Agent } from "@xmtp/agent-sdk";
import type { GameManager } from "../gameManager.js";
import {
  ContentTypeActions,
  type ActionsContent,
} from "../xmtp-inline-actions/types/index.js";
import { setPhaseTimer, clearPhaseTimer } from "../utils/timers.js";
import { GameState } from "../types.js";
import {
  TASK_PHASE_DURATION_MS,
  KILL_PHASE_DURATION_MS,
  DISCUSSION_PHASE_DURATION_MS,
  VOTING_PHASE_DURATION_MS,
  MAX_ROUNDS,
  KILL_SUCCESS_CHANCE,
  MAX_KILL_ATTEMPTS,
  KILL_COOLDOWN_SECONDS,
  CANCEL_GAME_WINDOW_MS,
  DISCUSSION_PHASE_DURATION_SECONDS,
  KILL_PHASE_DURATION_SECONDS,
} from "../config/gameConfig.js";
import { getPlayerAddress, formatAddressForMention } from "../utils/playerAddress.js";
import { sendKillButtons } from "../utils/killButtons.js";
import { sendVotingButtons } from "../utils/voteButtons.js";

export async function startGame(agent: Agent, gameManager: GameManager) {
  try {
    await gameManager.assignRoles();
    const lobbyId = gameManager.getGame().lobbyGroupId;

    if (lobbyId) {
      const group = await agent.client.conversations.getConversationById(lobbyId);
      if (group) {
        await group.send("Roles assigned.\n\nRound 1 is starting.");

        // Send game started message with cancel button (only works if game hasn't fully started)
        try {
          const cancelActionsContent: ActionsContent = {
            id: `cancel-game-${Date.now()}`,
            description: "🎮 Game Started!\n\nYou can cancel the game before Round 1 begins:",
            actions: [
              {
                id: "cancel-game",
                label: "❌ Cancel Game",
                style: "danger",
              },
            ],
            // Expire after cancel window (only allow cancellation briefly)
            expiresAt: new Date(Date.now() + CANCEL_GAME_WINDOW_MS).toISOString(),
          };

          // Try to send with content type using underlying client
          try {
            const client = (agent as any).client;
            if (client && client.conversations) {
              const conv = await client.conversations.getConversationById(lobbyId);
              if (conv) {
                await conv.send(cancelActionsContent, ContentTypeActions);
              } else {
                throw new Error("Could not get conversation");
              }
            } else {
              throw new Error("Could not access client");
            }
          } catch (error) {
            // Fallback to text message
            console.error("Error sending cancel button:", error);
            await group.send("🎮 Game Started! (Cancel option available for 10 seconds)");
          }
        } catch (error) {
          console.error("Error sending cancel button:", error);
        }

        // Start round 1
        await gameManager.startRound(1);
        await startTaskPhase(1, agent, gameManager);
      }
    }
  } catch (error) {
    console.error("Error starting game:", error);
  }
}

export async function startTaskPhase(
  round: number,
  agent: Agent,
  gameManager: GameManager
) {
  const lobbyId = gameManager.getGame().lobbyGroupId;
  if (!lobbyId) return;

  const group = await agent.client.conversations.getConversationById(lobbyId);
  if (!group) return;

  await group.send(
    `🛠️ Round ${round} — Task Phase\n\nComplete your assigned task by mentioning @mafia with your answer: @mafia /task <value>`
  );

  // Send individual tasks to all players in the group (including mafia)
  // Tasks are sent one by one to the group with player address mentions
  const players = gameManager.getAlivePlayers();
  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    const task = gameManager.getTaskForPlayer(player.inboxId);
    if (task) {
      try {
        // Get player address for mention
        const playerAddress = await getPlayerAddress(agent, player.inboxId, group);
        const addressMention = playerAddress
          ? `@${formatAddressForMention(playerAddress)}`
          : `@${player.username}`;

        // Send task to group with player mention
        // Mafia also gets a task (but it's fake - they can't complete it)
        // Don't reveal who is mafia
        await group.send(
          `${addressMention}\n\n🛠️ Your Task:\n\n${task.question}\n\nSubmit your answer: @mafia /task <answer>`
        );

        // Add a small delay between task messages (1 second)
        if (i < players.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (error) {
        console.error(`Failed to send task to ${player.username}:`, error);
        // Fallback: send without address mention
        try {
          await group.send(
            `@${player.username}\n\n🛠️ Your Task:\n\n${task.question}\n\nSubmit your answer: @mafia /task <answer>`
          );
          // Add delay even for fallback
          if (i < players.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } catch (fallbackError) {
          console.error(`Failed to send fallback task message:`, fallbackError);
        }
      }
    }
  }

  // After task phase duration, move to kill phase
  setPhaseTimer(`taskPhase-${round}`, TASK_PHASE_DURATION_MS, async () => {
    await gameManager.advancePhase();
    await startKillPhase(round, agent, gameManager);
  }, gameManager);
}

export async function startKillPhase(
  round: number,
  agent: Agent,
  gameManager: GameManager
) {
  const impostorInboxId = gameManager.getGame().impostorInboxId;
  if (!impostorInboxId) return;

  const impostor = gameManager.getPlayer(impostorInboxId);
  if (!impostor || !impostor.isAlive) return;

  const lobbyId = gameManager.getGame().lobbyGroupId;
  const group = lobbyId
    ? await agent.client.conversations.getConversationById(lobbyId)
    : null;

  // Announce kill phase to group
  if (group) {
    await group.send(
      `🔪 Round ${round} — Kill Phase\n\n` +
        `Kill phase duration: ${KILL_PHASE_DURATION_SECONDS} seconds.\n` +
        `The phase will automatically advance after the time limit.`
    );
  }

  try {
    const dm = await agent.client.conversations.newDm(impostorInboxId);
    
    // Send kill instructions
    await dm.send(
      `Round ${round} Kill Phase.\n\n` +
        `Success chance: ${(KILL_SUCCESS_CHANCE * 100).toFixed(0)}%\n` +
        `Max attempts: ${MAX_KILL_ATTEMPTS}\n` +
        `Cooldown: ${KILL_COOLDOWN_SECONDS} seconds per attempt\n` +
        `Phase duration: ${KILL_PHASE_DURATION_SECONDS} seconds\n\n` +
        `Select a target using the buttons below:`
    );

    // Send kill buttons
    await sendKillButtons(agent, dm, gameManager, round, impostorInboxId);
  } catch (error) {
    console.error("Failed to send kill phase DM:", error);
  }

  // Set timer to automatically advance to discussion phase after kill phase duration
  setPhaseTimer(`killPhase-${round}`, KILL_PHASE_DURATION_MS, async () => {
    // Only advance if we're still in kill phase (not already advanced by successful kill)
    const currentState = gameManager.getState();
    const isKillPhase =
      currentState === GameState.ROUND_1_KILL ||
      currentState === GameState.ROUND_2_KILL ||
      currentState === GameState.ROUND_3_KILL;

    if (isKillPhase) {
      await gameManager.advancePhase();
      await startDiscussionPhase(round, agent, gameManager);
    }
  }, gameManager);
}

export async function startDiscussionPhase(
  round: number,
  agent: Agent,
  gameManager: GameManager
) {
  const lobbyId = gameManager.getGame().lobbyGroupId;
  if (!lobbyId) return;

  const group = await agent.client.conversations.getConversationById(lobbyId);
  if (!group) return;

  await group.send(`💬 Discussion Phase — ${DISCUSSION_PHASE_DURATION_SECONDS} seconds.\n\nTalk freely.`);

  setPhaseTimer(`discussion-${round}`, DISCUSSION_PHASE_DURATION_MS, async () => {
    await gameManager.advancePhase();
    await startVotingPhase(round, agent, gameManager);
  }, gameManager);
}

export async function startVotingPhase(
  round: number,
  agent: Agent,
  gameManager: GameManager
) {
  const lobbyId = gameManager.getGame().lobbyGroupId;
  if (!lobbyId) return;

  const group = await agent.client.conversations.getConversationById(lobbyId);
  if (!group) return;

  // Send voting phase announcement
  await group.send(
    `🗳️ Voting Phase\n\n` +
      `Vote to eliminate a player using the buttons below:`
  );

  // Send voting buttons
  await sendVotingButtons(agent, group, gameManager, round);

  // Reset votes
  for (const player of gameManager.getAlivePlayers()) {
    player.voted = false;
    player.voteTarget = null;
  }

  // Wait for votes, then process after timer
  setPhaseTimer(`voting-${round}`, VOTING_PHASE_DURATION_MS, async () => {
    await processVoting(round, agent, gameManager);
  }, gameManager);
}

export async function processVoting(
  round: number,
  agent: Agent,
  gameManager: GameManager
) {
  const lobbyId = gameManager.getGame().lobbyGroupId;
  if (!lobbyId) return;

  const group = await agent.client.conversations.getConversationById(lobbyId);
  if (!group) return;

  const results = gameManager.getVoteResults();

  if (results.length === 0) {
    await group.send("No votes cast. No one eliminated.");
  } else {
    const topResult = results[0];
    const aliveCount = gameManager.getAlivePlayers().length;
    const majority = Math.ceil(aliveCount / 2);

    if (topResult.votes >= majority) {
      const eliminated = gameManager.getPlayer(topResult.target);
      if (eliminated) {
        await gameManager.eliminatePlayer(topResult.target);

        const roleEmoji = eliminated.role === "IMPOSTOR" ? "🔥" : "❌";
        const roleText = eliminated.role === "IMPOSTOR" ? "MAFIA" : "TOWN";

        await group.send(
          `${roleEmoji} @${eliminated.username} was eliminated.\n\n` +
            `They were a ${roleText}.`
        );

        // Check win condition
        const winCheck = gameManager.checkWinCondition();
        if (winCheck.gameEnded) {
          await endGame(winCheck.winner, agent, gameManager);
          return;
        }
      }
    } else {
      await group.send("Tie or no majority. No one eliminated.");
    }
  }

  // Advance to next round or end game
  if (round < MAX_ROUNDS) {
    await gameManager.advancePhase();
    const nextRound = round + 1;
    await gameManager.startRound(nextRound);
    await startTaskPhase(nextRound, agent, gameManager);
  } else {
    // Game end - mafia wins if still alive
    const winCheck = gameManager.checkWinCondition();
    await endGame(winCheck.winner || "IMPOSTOR", agent, gameManager);
  }
}

export async function endGame(
  winner: "CREW" | "IMPOSTOR" | null,
  agent: Agent,
  gameManager: GameManager
) {
  if (!winner) return;

  // Clear all timers when game ends
  const { clearAllTimers } = await import("../utils/timers.js");
  clearAllTimers(gameManager);

  const lobbyId = gameManager.getGame().lobbyGroupId;
  if (!lobbyId) return;

  const group = await agent.client.conversations.getConversationById(lobbyId);
  if (!group) return;

  if (winner === "CREW") {
    await group.send("🏆 TOWN WINS! Mafia was eliminated.");
  } else {
    await group.send(`🔥 MAFIA WINS! Survived all ${MAX_ROUNDS} rounds.`);
  }

  await gameManager.cleanup();
}

