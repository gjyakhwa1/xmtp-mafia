import type { Agent } from "@xmtp/agent-sdk";

/**
 * Get player address from inboxId by checking group members
 */
export async function getPlayerAddress(
  agent: Agent,
  inboxId: string,
  conversation: any
): Promise<string | null> {
  try {
    if (!conversation || !("members" in conversation)) {
      return null;
    }

    const members = await conversation.members();
    const member = members.find(
      (m: any) => m.inboxId.toLowerCase() === inboxId.toLowerCase()
    );

    if (member?.accountIdentifiers?.[0]?.identifier) {
      return member.accountIdentifiers[0].identifier;
    }

    // Fallback: try to get from preferences
    try {
      const inboxState = await agent.client.preferences.inboxStateFromInboxIds([
        inboxId,
      ]);
      const address = inboxState[0]?.identifiers[0]?.identifier;
      if (address) {
        return address;
      }
    } catch (error) {
      console.error("Error getting address from preferences:", error);
    }

    return null;
  } catch (error) {
    console.error("Error getting player address:", error);
    return null;
  }
}

/**
 * Format address for mention (use full address or shortened version)
 */
export function formatAddressForMention(address: string): string {
  // Use full address for mention
  return address;
}

