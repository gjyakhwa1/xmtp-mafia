import type { Agent } from "@xmtp/agent-sdk";
import type { IntentContent } from "../xmtp-inline-actions/types/index.js";
import { GameState } from "../types.js";
import type { GameManager } from "../gameManager.js";
import { getUsername } from "../utils/helpers.js";
import { sendJoinMessageToOriginalGroup } from "../utils/messages.js";
import { clearPhaseTimer, clearAllTimers } from "../utils/timers.js";
import { startGame } from "../game/gameFlow.js";
import { MAX_PLAYERS } from "../config/gameConfig.js";

// Handle intent messages (inline action button clicks)
// This handles button clicks from BOTH original group and lobby group
export async function handleIntentMessage(
  ctx: any,
  intentContent: IntentContent,
  agent: Agent,
  gameManager: GameManager
) {
  try {
    const actionId = intentContent.actionId;
    const senderInboxId = ctx.message.senderInboxId;
    const currentConversationId = ctx.conversation?.id;

    console.log(
      `🎯 Processing intent: ${actionId} from ${senderInboxId} in conversation ${currentConversationId}`
    );

    if (actionId === "join-game") {
      // Handle join game button click
      // This can be clicked from the original group (where the button is shown)
      const username = await getUsername(ctx);
      const result = await gameManager.addPlayer(senderInboxId, username);

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

            // Add player to lobby group if not already added
            if ("addMembers" in lobbyGroup) {
              try {
                await (lobbyGroup as any).addMembers([senderInboxId]);
              } catch (error) {
                // Member might already be added, ignore
              }
            }

            const players = Array.from(gameManager.getGame().players.values());
            const playerList = players.map((p) => p.username).join(", ");

            // IMPORTANT: Send updated lobby status with join button to ORIGINAL group only
            // This ensures the join button always appears in the main group, not the lobby group
            await sendJoinMessageToOriginalGroup(
              agent,
              originalGroup,
              lobbyGroup,
              `🚀 MAFIA LOBBY\n\nPlayers joined: ${playerList} (${players.length}/${MAX_PLAYERS})`
            );

            // Send confirmation to player in the conversation where they clicked the button
            // If they clicked from original group, they'll see it there
            // If they clicked from lobby group (shouldn't happen, but handle it), they'll see it there
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
    } else if (actionId === "cancel-game") {
      // Handle cancel game button click
      const state = gameManager.getState();
      if (
        state === GameState.WAITING_FOR_PLAYERS ||
        state === GameState.LOBBY_CREATED
      ) {
        // Only allow cancellation if game hasn't started
        const lobbyId = gameManager.getGame().lobbyGroupId;
        if (lobbyId) {
          const lobbyGroup =
            await agent.client.conversations.getConversationById(lobbyId);
          if (lobbyGroup) {
            await lobbyGroup.send("❌ Game cancelled by player.");
            clearAllTimers(gameManager);
            await gameManager.cleanup();
          }
        }
        await ctx.sendText("✅ Game cancelled.");
      } else {
        await ctx.sendText("❌ Cannot cancel game. Game has already started.");
      }
    } else if (actionId.startsWith("kill-")) {
      // Handle kill button click (DM only, Mafia only)
      const isDM = ctx.conversation && !("addMembers" in ctx.conversation);
      if (!isDM) {
        await ctx.sendText("❌ Kill commands can only be used in private messages (DMs).");
        return;
      }

      const targetInboxId = actionId.replace("kill-", "");
      const targetPlayer = gameManager.getPlayer(targetInboxId);
      
      if (!targetPlayer) {
        await ctx.sendText("❌ Target player not found.");
        return;
      }

      // Attempt kill using the target's username
      const result = await gameManager.attemptKill(
        senderInboxId,
        targetPlayer.username
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

            // Clear the kill phase timer since we're advancing early
            const { clearPhaseTimer } = await import("../utils/timers.js");
            const currentRound = gameManager.getGame().round;
            clearPhaseTimer(`killPhase-${currentRound}`, gameManager);

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
    } else if (actionId.startsWith("vote-")) {
      // Handle vote button click (Group only)
      const isDM = ctx.conversation && !("addMembers" in ctx.conversation);
      if (isDM) {
        await ctx.sendText("❌ Voting must be done in the game lobby group.");
        return;
      }

      const targetInboxId = actionId.replace("vote-", "");
      const targetPlayer = gameManager.getPlayer(targetInboxId);
      
      if (!targetPlayer) {
        await ctx.sendText("❌ Target player not found.");
        return;
      }

      const voter = gameManager.getPlayer(senderInboxId);
      if (!voter || !voter.isAlive) {
        await ctx.sendText("❌ You are not part of an active game or have been eliminated.");
        return;
      }

      // Check if we're in a voting phase
      const isVotingPhase =
        gameManager.getState() === GameState.ROUND_1_VOTING ||
        gameManager.getState() === GameState.ROUND_2_VOTING ||
        gameManager.getState() === GameState.ROUND_3_VOTING;

      if (!isVotingPhase) {
        await ctx.sendText("❌ It's not the voting phase.");
        return;
      }

      // Cast vote
      if (voter.voted) {
        await ctx.sendText(`✅ You changed your vote to ${targetPlayer.username}.`);
      } else {
        await ctx.sendText(`✅ You voted to eliminate ${targetPlayer.username}.`);
      }

      voter.voted = true;
      voter.voteTarget = targetInboxId;
    } else {
      await ctx.sendText(`❌ Unknown action: ${actionId}`);
    }
  } catch (error: any) {
    console.error("Error handling intent message:", error);
    await ctx.sendText(`❌ Error processing action: ${error.message}`);
  }
}

