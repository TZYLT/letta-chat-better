/**
 * The one-shot handoff between `/compact` and the picker.
 *
 * The bridge exists because the submit handler can open an overlay but cannot
 * pass it props; the failure mode it must not have is a *stale* request, since
 * a leftover topic list would appear the next time someone opens `/compaction`.
 */
import { describe, expect, test } from "bun:test";
import {
  clearTopicTrimRequest,
  setTopicTrimRequest,
  type TopicTrimRequest,
  takeTopicTrimRequest,
} from "@/cli/helpers/topic-trim-request";

function request(marker: string): TopicTrimRequest {
  return {
    blocks: [],
    suggestionIndex: 1,
    onPick: () => {
      throw new Error(`picked ${marker}`);
    },
  };
}

describe("topic trim request bridge", () => {
  test("hands the request over exactly once", () => {
    setTopicTrimRequest(request("first"));

    expect(takeTopicTrimRequest()?.suggestionIndex).toBe(1);
    expect(takeTopicTrimRequest()).toBeNull();
  });

  test("clearing drops a request nobody took", () => {
    setTopicTrimRequest(request("stale"));
    clearTopicTrimRequest();

    expect(takeTopicTrimRequest()).toBeNull();
  });

  test("a newer request replaces an untaken one", () => {
    setTopicTrimRequest(request("old"));
    setTopicTrimRequest(request("new"));

    expect(takeTopicTrimRequest()).not.toBeNull();
    expect(takeTopicTrimRequest()).toBeNull();
  });
});
