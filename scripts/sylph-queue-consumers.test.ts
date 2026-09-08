import { expect, test } from "bun:test"
import { reviewQueueConsumerTransition } from "./sylph-queue-consumers"

test("the reviewed consumer data file permits only existing Queue detachment", () => {
  expect(() =>
    reviewQueueConsumerTransition("{}", '{"JOBS":false}', ["JOBS"])
  ).not.toThrow()
  expect(() =>
    reviewQueueConsumerTransition('{"JOBS":true}', '{"JOBS":false}', ["JOBS"])
  ).not.toThrow()
  expect(() =>
    reviewQueueConsumerTransition('{"JOBS":false}', "{}", ["JOBS"])
  ).toThrow("only detaches")
  expect(() =>
    reviewQueueConsumerTransition("{}", '{"FOREIGN":false}', ["JOBS"])
  ).toThrow("existing managed")
  expect(() =>
    reviewQueueConsumerTransition("{}", '{"JOBS":"false"}', ["JOBS"])
  ).toThrow()
})

test("verified target restoration permits consumer reattachment without foreign bindings", () => {
  expect(() =>
    reviewQueueConsumerTransition('{"JOBS":false}', "{}", ["JOBS"], true)
  ).not.toThrow()
  expect(() =>
    reviewQueueConsumerTransition(
      '{"JOBS":false}',
      '{"FOREIGN":true}',
      ["JOBS"],
      true
    )
  ).toThrow("existing managed")
})
