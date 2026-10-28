import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkFile, findingContext, hashChunk } from "../src/core/chunk.js";

function numberedBody(text: string): string[] {
  return text.split("\n");
}

describe("chunk", () => {
  it("splits with overlap, numbering, and header", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `const x${i + 1} = "body";`);
    const content = lines.join("\n");
    const chunks = chunkFile("src/big.ts", content, 2000, 10, 5);
    assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
    assert.equal(chunks[0].startLine, 1);
    assert.equal(chunks[chunks.length - 1].endLine, 200);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      assert.equal(c.file, "src/big.ts");
      assert.equal(c.chunkIndex, i);
      assert.equal(c.totalChunks, chunks.length);
      assert.equal(c.header, lines.slice(0, 5).join("\n"));
      assert.ok(numberedBody(c.text).length === c.endLine - c.startLine + 1);
      assert.match(numberedBody(c.text)[0], new RegExp(`^${c.startLine}\\| `));
      const expected = Array.from(
        { length: c.endLine - c.startLine + 1 },
        (_, k) => `${c.startLine + k}| ${lines[c.startLine + k - 1]}`,
      ).join("\n");
      assert.equal(c.text, expected);
      assert.ok(
        c.text.length <= 2000,
        `chunk ${i} body ${c.text.length} chars exceeds cap`,
      );
      if (i + 1 < chunks.length) {
        const next = chunks[i + 1];
        assert.equal(next.startLine, c.endLine - 10 + 1);
      }
    }
  });

  it("produces stable hashes equal to hashChunk over the raw body", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    const content = lines.join("\n");
    const a = chunkFile("src/big.ts", content, 500, 5, 3);
    const b = chunkFile("src/big.ts", content, 500, 5, 3);
    assert.deepEqual(
      a.map((c) => c.hash),
      b.map((c) => c.hash),
    );
    assert.deepEqual(
      a.map((c) => c.contextHash),
      b.map((c) => c.contextHash),
    );
    const first = a[0];
    const raw = numberedBody(first.text)
      .map((l) => l.replace(/^\d+\| /, ""))
      .join("\n");
    assert.equal(raw, lines.slice(first.startLine - 1, first.endLine).join("\n"));
    assert.equal(first.hash, hashChunk("src/big.ts", raw));
    assert.equal(hashChunk("src/big.ts", raw) === hashChunk("src/big.ts", raw + " "), false);
  });

  it("findingContext drifts on nearby edits and holds on far edits", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `  statement_${i + 1}();  `);
    const before = findingContext(lines, 50);
    const near = [...lines];
    near[54] = "statement_CHANGED();";
    assert.notEqual(findingContext(near, 50), before);
    const far = [...lines];
    far[90] = "statement_CHANGED();";
    assert.equal(findingContext(far, 50), before);
    assert.equal(findingContext(lines, 50), before);
  });

  it("keeps small files in a single chunk with full header", () => {
    const chunks = chunkFile("src/small.ts", "a\nb\nc", 40000, 40, 30);
    assert.equal(chunks.length, 1);
    assert.deepEqual([chunks[0].startLine, chunks[0].endLine], [1, 3]);
    assert.equal(chunks[0].text, "1| a\n2| b\n3| c");
    assert.equal(chunks[0].header, "a\nb\nc");
  });
});
