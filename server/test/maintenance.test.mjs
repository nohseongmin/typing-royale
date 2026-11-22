import assert from "node:assert/strict";
import {test} from "node:test";
import worker, {Room, Matchmaker} from "../src/maintenance.js";

test("public requests always receive the maintenance notice without opening a game", async () => {
  for (const path of ["/", "/?room=ABC", "/app.js", "/join", "/ws", "/auth/kakao/start"]) {
    const response = worker.fetch(new Request("https://game.test" + path));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.match(await response.text(), /게임물 등급분류/);
  }
  for (const handler of [worker, new Room(), new Matchmaker()]) {
    const response = handler.fetch(new Request("https://game.test/", {method:"HEAD"}));
    assert.equal(response.status, 503);
    assert.equal(response.body, null);
  }
});
