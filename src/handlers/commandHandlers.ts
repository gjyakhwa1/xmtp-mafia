import type { Agent } from "@xmtp/agent-sdk";
import { GameState } from "../types.js";
import type { GameManager } from "../gameManager.js";
import {
  getUsername,
  rejectCommandInDM,
} from "../utils/helpers.js";
import { requireLobbyGroup } from "../utils/lobby.js";
import { sendJoinMessageToOriginalGroup } from "../utils/messages.js";
import { setPhaseTimer, clearPhaseTimer } from "../utils/timers.js";
import { startGame } from "../game/gameFlow.js";
import {
  MAX_PLAYERS,
  JOIN_WINDOW_DURATION_MS,
  JOIN_WINDOW_DURATION_SECONDS,
} from "../config/gameConfig.js";

// Handle /start command
export function setupStartHandler(agent: Agent, gameManager: GameManager) {
  return async (ctx: any) => {
    const parsed = ctx.parsedCommand;
    console.log("parsed", parsed);
    if (!parsed || parsed.command !== "start") {
      return;
    }

    // Reject command if sent in DM
    if (await rejectCommandInDM(ctx)) {
      return;
    }

    try {
      const username = await getUsername(ctx);
      const originalGroupId = ctx.conversation?.id;

      if (!originalGroupId) {
        await ctx.sendText("❌ Error: Could not identify the group.");
        return;
      }

      // Create lobby with original group ID
      const lobbyId = await gameManager.createLobby(originalGroupId);

      // Add the player who started the game
      const addResult = await gameManager.addPlayer(
        ctx.message.senderInboxId,
        username
      );

      if (!addResult.success) {
        await ctx.sendText(
          "❌ Error: Could not add you to the lobby. Please try again."
        );
        return;
      }

      // Get both groups
      const originalGroup =
        await agent.client.conversations.getConversationById(originalGroupId);
      const lobbyGroup = await agent.client.conversations.getConversationById(lobbyId);

      if (originalGroup && lobbyGroup) {
        // Add starter to the lobby group if not already added
        if ("addMembers" in lobbyGroup) {
          try {
            await (lobbyGroup as any).addMembers([ctx.message.senderInboxId]);
          } catch (error) {
            // Member might already be added, ignore
          }
        }

        // Send join message to the ORIGINAL group (where /start was called)
        await sendJoinMessageToOriginalGroup(
          agent,
          originalGroup,
          lobbyGroup,
          `🚀 MAFIA Game Lobby Created!\n\nUp to ${MAX_PLAYERS} players may join within ${JOIN_WINDOW_DURATION_SECONDS / 60} minutes.`
        );

        // Set timer to start game after join window
        setPhaseTimer("joinWindow", JOIN_WINDOW_DURATION_MS, async () => {
          if (gameManager.getState() === GameState.WAITING_FOR_PLAYERS) {
            if (gameManager.canStartGame()) {
              await startGame(agent, gameManager);
            } else {
              await lobbyGroup.send("Not enough players joined. Game cancelled.");
              const { clearAllTimers } = await import("../utils/timers.js");
              clearAllTimers(gameManager);
              await gameManager.cleanup();
            }
          }
        }, gameManager);
      }
    } catch (error: any) {
      await ctx.sendText(`❌ Error creating lobby: ${error.message}`);
    }
  };
}

// Handle /join command (only works in lobby group)
export function setupJoinHandler(agent: Agent, gameManager: GameManager) {
  return async (ctx: any) => {
    const parsed = ctx.parsedCommand;
    if (!parsed || parsed.command !== "join") {
      return;
    }

    // Reject command if sent in DM
    if (await rejectCommandInDM(ctx)) {
      return;
    }

    // Only allow /join in the lobby group
    if (!(await requireLobbyGroup(ctx, "join", gameManager))) {
      return;
    }

    try {
      const username = await getUsername(ctx);
      const result = await gameManager.addPlayer(
        ctx.message.senderInboxId,
        username
      );

      if (!result.success) {
        await ctx.sendText(
          "❌ Cannot join at this time. The game may be full or already in progress."
        );
        return;
      }

      const state = gameManager.getState();
      if (state === GameState.WAITING_FOR_PLAYERS) {
        const lobbyId = gameManager.getGame().lobbyGroupId;
        const originalGroupId = gameManager.getGame().originalGroupId;

        if (lobbyId && originalGroupId) {
          const lobbyGroup =
            await agent.client.conversations.getConversationById(lobbyId);
          const originalGroup = await agent.client.conversations.getConversationById(
            originalGroupId
          );

          if (lobbyGroup && originalGroup) {
            // Notify removed player if one was removed
            if (result.removedPlayer) {
              try {
                const dm = await agent.client.conversations.newDm(
                  result.removedPlayer.inboxId
                );
                await dm.send(
                  "⚠️ You were removed from the lobby to make room for a new player.\n\nYou can join again if there's space."
                );
              } catch (error) {
                console.error(`Failed to notify removed player:`, error);
              }

              // Notify lobby group about the removal
              await lobbyGroup.send(
                `⚠️ ${result.removedPlayer.username} was removed to make room for ${username}.`
              );
            }

            const players = Array.from(gameManager.getGame().players.values());
            const playerList = players.map((p) => p.username).join(", ");

            // Send updated lobby status to original group
            await sendJoinMessageToOriginalGroup(
              agent,
              originalGroup,
              lobbyGroup,
              `🚀 MAFIA LOBBY\n\nPlayers joined: ${playerList} (${players.length}/${MAX_PLAYERS})`
            );

            // Send confirmation to player in lobby group
            await ctx.sendText(
              `✅ You joined the game! Players: ${playerList} (${players.length}/${MAX_PLAYERS})`
            );

            // If lobby is full, start immediately
            if (players.length >= MAX_PLAYERS) {
              clearPhaseTimer("joinWindow", gameManager);
              await startGame(agent, gameManager);
            }
          }
        }
      }
    } catch (error: any) {
      await ctx.sendText(`❌ Error joining: ${error.message}`);
    }
  };
}

// Handle /task command
// Note: This command requires agent mention (handled by middleware)
export function setupTaskHandler(gameManager: GameManager) {
  return async (ctx: any) => {
    const parsed = ctx.parsedCommand;
    if (!parsed || parsed.command !== "task") {
      return;
    }

    // Ensure this is in a group (not DM) - tasks should be submitted in the lobby group
    const isDM = ctx.conversation && !("addMembers" in ctx.conversation);
    if (isDM) {
      await ctx.sendText(
        "❌ Task submissions should be done in the game lobby group, not in private messages.\n\nUse: @mafia /task <answer> in the lobby group."
      );
      return;
    }

    try {
      if (!parsed.args || parsed.args.length === 0) {
        await ctx.sendText("Usage: @mafia /task <value>");
        return;
      }

      const answer = parsed.args.join(" ");
      const player = gameManager.getPlayer(ctx.message.senderInboxId);

      if (!player || !player.isAlive) {
        await ctx.sendText(
          "You are not part of an active game or have been eliminated."
        );
        return;
      }

      // Mafia can submit tasks but they don't actually complete
      // Give them the same response as town to not reveal identity
      if (player.role === "IMPOSTOR") {
        // Mafia's task submission will always fail validation (handled in gameManager)
        // But we give them a neutral response
        await ctx.sendText("❌ Task answer incorrect. Try again.");
        return;
      }

      // Crew members must complete real tasks
      const completed = await gameManager.completeTask(
        ctx.message.senderInboxId,
        answer
      );

      if (completed) {
        await ctx.sendText("✅ Task completed!");
      } else {
        await ctx.sendText("❌ Task answer incorrect. Try again.");
      }
    } catch (error: any) {
      await ctx.sendText(`Error: ${error.message}`);
    }
  };
}

// Handle kill command (DM only)
export function setupKillHandler(agent: Agent, gameManager: GameManager) {
  return async (ctx: any) => {
    const parsed = ctx.parsedCommand;
    if (!parsed || parsed.command !== "kill") {
      return;
    }

    // Only allow kills in DMs
    const isDM = ctx.conversation && !("addMembers" in ctx.conversation);
    if (!isDM) {
      await ctx.sendText(
        "Kill commands can only be used in private messages (DMs)."
      );
      return;
    }

    try {
      if (!parsed.args || parsed.args.length === 0) {
        await ctx.sendText("Usage: @mafia kill <username>");
        return;
      }

      const targetUsername = parsed.args.join(" ");
      const result = await gameManager.attemptKill(
        ctx.message.senderInboxId,
        targetUsername
      );

      await ctx.sendText(result.message);

      // If kill was successful, announce to group
      if (result.success) {
        const lobbyId = gameManager.getGame().lobbyGroupId;
        if (lobbyId) {
          const group =
            await agent.client.conversations.getConversationById(lobbyId);
          if (group) {
            await group.send(result.message);

            // Check win condition
            const winCheck = gameManager.checkWinCondition();
            if (winCheck.gameEnded) {
              const { endGame } = await import("../game/gameFlow.js");
              await endGame(winCheck.winner, agent, gameManager);
              return;
            }

            // Advance to discussion phase after a short delay
            setTimeout(async () => {
              await gameManager.advancePhase();
              const { startDiscussionPhase } = await import("../game/gameFlow.js");
              await startDiscussionPhase(
                gameManager.getGame().round,
                agent,
                gameManager
              );
            }, 2000);
          }
        }
      }
    } catch (error: any) {
      await ctx.sendText(`Error: ${error.message}`);
    }
  };
}

// Handle vote command
export function setupVoteHandler(gameManager: GameManager) {
  return async (ctx: any) => {
    const parsed = ctx.parsedCommand;
    if (!parsed || parsed.command !== "vote") {
      return;
    }

    try {
      if (!parsed.args || parsed.args.length === 0) {
        await ctx.sendText("Usage: @mafia vote <username>");
        return;
      }

      const targetUsername = parsed.args.join(" ");
      const voted = await gameManager.castVote(
        ctx.message.senderInboxId,
        targetUsername
      );

      if (!voted) {
        await ctx.sendText("Cannot vote at this time or already voted.");
        return;
      }

      await ctx.sendText(`✅ Voted for ${targetUsername}`);
    } catch (error: any) {
      await ctx.sendText(`Error: ${error.message}`);
    }
  };
}

