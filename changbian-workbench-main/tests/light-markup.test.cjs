const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const esbuild = require("esbuild");

function loadLightMarkup() {
  const entry = path.join(__dirname, "..", "src", "light-markup.ts");
  const result = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const compiled = new Module(entry);
  compiled.paths = Module._nodeModulePaths(path.dirname(entry));
  compiled._compile(result.outputFiles[0].text, entry);
  return compiled.exports;
}

const { applyLightMarkup } = loadLightMarkup();

// 舊寫法：逐條正則替換。沒有標籤時新舊結果應一致。
function legacy(html) {
  return html
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<u>$1</u>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/\r?\n/g, "<br />");
}

test("輕量標記：沒有標籤時與逐條正則替換結果一致", () => {
  const samples = [
    "**史可法** 禮部尚書",
    "甲__乙__丙*丁*戊",
    "**粗**與*斜*與__線__\n下一行",
    "未配對的 ** 符號",
    "***三個星號***",
    "a*b**c*d**e",
    "_單底線_ 與 __雙底線__",
    "𠀀**𠀁**𠀂",
    "",
  ];
  for (const sample of samples) {
    assert.equal(applyLightMarkup(sample), legacy(sample), sample);
  }
});

test("輕量標記：粗體跨過高亮標籤時，標籤仍正確嵌套、高亮不被截斷", () => {
  const html =
    '**<span class="align-block" data-block="0"><mark class="diff-same">史可法**　禮部尚書。\n**高弘圖**　禮部</mark></span>';
  const out = applyLightMarkup(html);
  assert.equal(
    out,
    '<span class="align-block" data-block="0"><mark class="diff-same"><strong>史可法</strong>　禮部尚書。<br />' +
      "<strong>高弘圖</strong>　禮部</mark></span>",
  );
  // 每個開標籤都有對應的關標籤，且依序嵌套。
  const stack = [];
  for (const match of out.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
    if (match[2] === "br") continue;
    if (match[1]) {
      assert.equal(stack.pop(), match[2]);
    } else {
      stack.push(match[2]);
    }
  }
  assert.deepEqual(stack, []);
});

test("輕量標記：交疊的格式依序關閉再重開", () => {
  assert.equal(applyLightMarkup("**甲__乙**丙__"), "<strong>甲<u>乙</u></strong><u>丙</u>");
});
