import { Rpc } from "@opencode/plugin/rpc"

const windowShape = {
  type: "object",
  properties: {
    spent: { type: "number" },
    limit: { type: "number" },
  },
  required: ["spent", "limit"],
  additionalProperties: false,
} as const

const accountWin = {
  type: "object",
  properties: {
    percent: { type: "number" },
    resetAt: { type: "string" },
  },
  required: ["percent", "resetAt"],
  additionalProperties: false,
} as const

const snapshot = {
  type: "object",
  properties: {
    provider: { type: "string" },
    windows: {
      type: "object",
      properties: {
        h5: windowShape,
        d7: windowShape,
        d30: windowShape,
      },
      required: ["h5", "d7", "d30"],
      additionalProperties: false,
    },
    account: {
      type: "object",
      properties: {
        h5: accountWin,
        d7: accountWin,
        d30: accountWin,
      },
      required: ["h5", "d7", "d30"],
      additionalProperties: false,
    },
  },
  required: ["provider", "windows"],
  additionalProperties: false,
} as const

export const QuotaSplitRpc = Rpc.define({
  id: "quota-split",
  methods: {
    usage: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: snapshot,
    },
    setLimits: {
      input: {
        type: "object",
        properties: {
          limits: {
            type: "object",
            properties: {
              h5: { type: "number" },
              d7: { type: "number" },
              d30: { type: "number" },
            },
            additionalProperties: false,
          },
        },
        required: ["limits"],
        additionalProperties: false,
      },
      output: snapshot,
    },
  },
  events: {
    updated: { schema: { type: "object", additionalProperties: false } },
  },
})
