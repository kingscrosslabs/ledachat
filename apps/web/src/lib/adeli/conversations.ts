import "server-only";

import type { Adeli } from "@adeli/sdk";

import { adeliCall } from "./client";

/** One message in an Instagram conversation, newest first in a `ConversationRead`. */
export type ConversationMessage = {
  id: string;
  direction: "inbound" | "outbound";
  fromId: string | null;
  text: string | null;
  createdAt: string;
};

export type ConversationRead = { available: false } | { available: true; messages: ConversationMessage[] };

type ConversationResponse = { data: { messages: ConversationMessage[] } };
type ConversationReader = {
  getInstagramConversation(args: { path: { igsid: string }; query: { accountId: string; limit?: number } }): Promise<ConversationResponse>;
};

/**
 * `messages.getInstagramConversation` arrives in an @adeli/sdk release after
 * 0.9.0 (Adeli `GET /messages/instagram/conversations/:igsid`). Until the
 * installed SDK has it, reads report `available: false` and the missed-tap
 * check does nothing. Once the dependency is bumped this lookup can go.
 */
function conversationReader(client: Adeli): ConversationReader | null {
  const messages = client.messages as unknown as Partial<ConversationReader>;
  return typeof messages.getInstagramConversation === "function" ? (messages as ConversationReader) : null;
}

/**
 * The newest `limit` messages between an account and one person, read live
 * from Instagram. The caller passes only an account and person from its own
 * user's run.
 */
export async function readConversation(adeliAccountId: string, igsid: string, limit = 5): Promise<ConversationRead> {
  return adeliCall(async (client) => {
    const reader = conversationReader(client);
    if (!reader) return { available: false as const };
    const { data } = await reader.getInstagramConversation({ path: { igsid }, query: { accountId: adeliAccountId, limit } });
    return { available: true as const, messages: data.messages };
  });
}
