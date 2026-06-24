// Chat with system prompt, persona, and automatic function calling.
//   ADDIS_API_KEY=... node examples/chat-tools.mjs
import AddisAI from "addisai";

const addis = new AddisAI();

const fakeOrders = { "123": { status: "shipped", eta: "tomorrow" } };

const final = await addis.chat.runTools({
  language: "am",
  system: "Be concise.",
  persona: "You are ShopBot by AcmeCorp.",
  messages: [{ role: "user", content: "Check order 123 and summarize it." }],
  tools: [
    {
      type: "function",
      function: {
        name: "get_order_status",
        description: "Fetch order status by order ID.",
        parameters: {
          type: "object",
          properties: { order_id: { type: "string" } },
          required: ["order_id"],
        },
        function: async ({ order_id }) => fakeOrders[order_id] ?? { status: "unknown" },
      },
    },
  ],
});

console.log(final.choices[0].message.content);
