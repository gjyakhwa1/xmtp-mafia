import type { Agent } from "@xmtp/agent-sdk";
import {
  ContentTypeActions,
  type ActionsContent,
} from "../xmtp-inline-actions/types/index.js";
import { VOTING_PHASE_DURATION_MS } from "../config/gameConfig.js";
import type { GameManager } from "../gameManager.js";
import { getPlayerAddress } from "./playerAddress.js";

/**
 * Send voting buttons for all alive players in the group
 */
export async function sendVotingButtons(
  agent: Agent,
  group: any,
  gameManager: GameManager,
  round: number
): Promise<void> {
  try {
    const alivePlayers = gameManager.getAlivePlayers();
    
    if (alivePlayers.length === 0) {
      return;
    }

    // Create buttons for each alive player
    const voteActions = await Promise.all(
      alivePlayers.map(async (player) => {
        // Try to get player address for display
        const playerAddress = await getPlayerAddress(agent, player.inboxId, group);
        const displayName = playerAddress 
          ? `${player.username} (${playerAddress.slice(0, 6)}...${playerAddress.slice(-4)})`
          : player.username;

        return {
          id: `vote-${player.inboxId}`,
          label: `🗳️ ${displayName}`,
          style: "primary" as const,
        };
      })
    );

    const actionsContent: ActionsContent = {
      id: `voting-${round}-${Date.now()}`,
      description: `🗳️ Vote to eliminate a player:\n\nClick a button below to vote.`,
      actions: voteActions,
      expiresAt: new Date(Date.now() + VOTING_PHASE_DURATION_MS).toISOString(),
    };

    // Send using underlying client
    const client = (agent as any).client;
    if (client && client.conversations) {
      const conv = await client.conversations.getConversationById(group.id);
      if (conv) {
        await conv.send(actionsContent, ContentTypeActions);
      } else {
        throw new Error("Could not get conversation");
      }
    } else {
      throw new Error("Could not access client");
    }
  } catch (error) {
    console.error("Error sending voting buttons:", error);
    // Fallback: send text message with instructions
    const aliveUsernames = gameManager.getAlivePlayerUsernames();
    await group.send(
      `🗳️ Voting Phase\n\n` +
        `Use: @mafia vote <username>\n\n` +
        `Alive players: ${aliveUsernames.join(", ")}`
    );
  }
}

