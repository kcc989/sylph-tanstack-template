import { expect, test } from "bun:test"
import {
  replayManagedQueues,
  requireEmptyQueueJournals,
} from "./sylph-queue-replay"

const configuration = {
  apiBaseUrl: "https://broker.invalid/accounts/account",
  apiToken: "private",
  controlDatabaseId: "control",
}
const queues = [
  { queueId: "queue-id", queueName: "reserved-jobs", databaseId: "app" },
]
function provider(owner = "release", failSend = false) {
  const messages: object[] = []
  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    const body = JSON.parse(String(init?.body))
    if (path.endsWith("/messages")) {
      messages.push(body)
      return Response.json(
        { success: !failSend },
        { status: failSend ? 503 : 200 }
      )
    }
    expect(body.sql).toStartWith("SELECT")
    const rows = path.includes("/control/")
      ? [{ owner, active: 0 }]
      : body.params[1] === ""
        ? [{ id: "first" }, { id: "second" }]
        : []
    return Response.json({
      success: true,
      result: [{ success: true, results: rows }],
    })
  }
  return {
    request: Object.assign(request, { preconnect: fetch.preconnect }),
    messages,
  }
}

test("replay publishes journal IDs as JSON notifications while paused", async () => {
  const p = provider()
  expect(
    await replayManagedQueues(configuration, queues, "release", p.request)
  ).toEqual({ sent: 2 })
  expect(p.messages).toEqual(
    ["first", "second"].map((id) => ({
      body: { version: 1, queue: "reserved-jobs", id },
      content_type: "json",
    }))
  )
})

test("wrong gate owner blocks replay and provider failure prevents successful resume preparation", async () => {
  const wrong = provider("other")
  await expect(
    replayManagedQueues(configuration, queues, "release", wrong.request)
  ).rejects.toThrow("fully paused")
  expect(wrong.messages).toHaveLength(0)
  const unavailable = provider("release", true)
  await expect(
    replayManagedQueues(configuration, queues, "release", unavailable.request)
  ).rejects.toThrow("remain paused")
  expect(unavailable.messages).toHaveLength(1)
})

test("consumer detachment refuses pending journal work without publishing notifications", async () => {
  const p = provider()
  await expect(
    requireEmptyQueueJournals(configuration, queues, "release", p.request)
  ).rejects.toThrow("pending journal")
  expect(p.messages).toHaveLength(0)
})
