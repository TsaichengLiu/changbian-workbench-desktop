const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const esbuild = require("esbuild");

// src/similarity.ts 是 TypeScript，測試時用 esbuild 即時打包成 CommonJS 再載入。
function loadSimilarity() {
  const entry = path.join(__dirname, "..", "src", "similarity.ts");
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

const {
  toComparableText,
  diffTokens,
  compareTexts,
  markedRanges,
  SimilarityIndex,
  clampGramSize,
  clampMinOrderConsistency,
  alignTexts,
  clearSimilarityCaches,
} = loadSimilarity();

test("比對時忽略標點，並把繁簡、舊字形歸一", () => {
  const traditional = toComparableText("爲明復仇，說之。");
  const simplified = toComparableText("为明复仇说之");
  assert.deepEqual(traditional.tokens, simplified.tokens);
  assert.deepEqual(toComparableText("爲明", true).tokens, ["爲", "明"]);
  // □ 是缺字符號，代表一個字，不能當標點去掉。
  assert.equal(toComparableText("張□彥，").tokens.length, 3);
});

test("token 位置對應回原文，含擴展區生僻字", () => {
  const text = "𫍲聞，隨筆";
  const comparable = toComparableText(text);
  assert.equal(comparable.tokens.length, 4);
  assert.equal(text.slice(comparable.starts[0], comparable.ends[0]), "𫍲");
  assert.equal(text.slice(comparable.starts[2], comparable.ends[2]), "隨");
});

test("逐字比勘找出異文、脫文與衍文", () => {
  const result = compareTexts("永綏福祿，共保山河。", "永綏福位，共保河山之固。");
  assert.equal(result.aligned, true);
  const pairs = result.hunks.map((hunk) => [
    result.left.tokens.slice(hunk.aStart, hunk.aEnd).join(""),
    result.right.tokens.slice(hunk.bStart, hunk.bEnd).join(""),
  ]);
  assert.deepEqual(pairs[0], ["禄", "位"]);
  assert.ok(pairs.some(([left, right]) => left === "" && right.includes("固")), "右有左無應被列出");
  const ranges = markedRanges(result.left, result.leftMarks);
  assert.equal("永綏福祿，共保山河。".slice(ranges[0].start, ranges[0].end), "祿");
});

test("繁簡不同的同一段文字不算異文，嚴格模式下才算", () => {
  assert.equal(compareTexts("君父之仇，不共戴天", "君父之讎不共戴天").hunks.length, 1);
  assert.equal(compareTexts("爲明復仇", "为明复仇").hunks.length, 0);
  // 嚴格模式：爲/为、復/复 兩處（明、仇 相同）。
  assert.equal(compareTexts("爲明復仇", "为明复仇", true).hunks.length, 2);
});

test("差異過大時放棄逐字對齊", () => {
  assert.equal(diffTokens([..."甲乙丙丁戊己"], [..."子丑寅卯辰巳"], 3), null);
  const result = compareTexts("甲乙丙丁戊己", "子丑寅卯辰巳");
  assert.equal(result.aligned, true);
  assert.equal(result.equalChars, 0);
});

const SOURCE =
  "大清攝政王遣副將唐起龍招撫江南致書史可法有曰君父之仇不共戴天闖賊手毒君親中國臣民不聞加遺一矢" +
  "朝廷念宗社之重爲之報仇雪恥所以不憚征繕之勞者欲與明朝共保山河永綏福祿";

test("相似文本：節錄本排在前面，無關文本不入選", () => {
  const abridged = "攝政王致書史可法曰君父之仇不共戴天闖賊手毒君親中國臣民不聞加遺一矢欲與明朝共保山河永綏福位";
  const unrelated = "張履祥聞北都之變痛哭失聲與門人論守身之道謂當讀書明理不可隨俗俯仰";
  const index = new SimilarityIndex([
    { id: "source", text: SOURCE },
    { id: "abridged", text: abridged },
    { id: "unrelated", text: unrelated },
    { id: "empty", text: "" },
  ]);
  const matches = index.findSimilar("source");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].entryId, "abridged");
  assert.ok(matches[0].candidateCoverage > matches[0].anchorCoverage, "節錄本被原文覆蓋的比例應更高");
  assert.ok(matches[0].orderConsistency > 0.9);
  assert.ok(matches[0].candidateRun.end > matches[0].candidateRun.start);
});

test("片段長度：異文密集時三字能找到、四字找不到；六字更嚴格", () => {
  // 每隔三字換一字：只剩三字長的共有片段。
  const dense = "天下大亂兵戈四起民不聊生盜賊蜂起官軍無功";
  const denseCopy = [...dense].map((char, index) => (index % 4 === 3 ? "某" : char)).join("");
  const dense4 = new SimilarityIndex([{ id: "a", text: dense }, { id: "b", text: denseCopy }]);
  const dense3 = new SimilarityIndex([{ id: "a", text: dense }, { id: "b", text: denseCopy }], { gramSize: 3 });
  assert.equal(dense4.findSimilar("a").length, 0);
  assert.equal(dense3.findSimilar("a")[0]?.entryId, "b");

  // 共有片段最長四字：四字能找到，五字、六字找不到。
  const runs = "君父之仇甲不共戴天乙闖賊手毒丙中國臣民丁不聞加遺戊";
  const runsCopy = "君父之仇子不共戴天丑闖賊手毒寅中國臣民卯不聞加遺辰";
  const docs = [{ id: "a", text: runs }, { id: "b", text: runsCopy }];
  assert.equal(new SimilarityIndex(docs, { gramSize: 5 }).findSimilar("a").length, 0);
  assert.equal(new SimilarityIndex(docs, { gramSize: 4 }).findSimilar("a")[0]?.entryId, "b");
  assert.equal(new SimilarityIndex(docs, { gramSize: 6 }).findSimilar("a").length, 0);

  assert.equal(new SimilarityIndex(docs).gramSize, 4);
  assert.equal(clampGramSize(2), 3);
  assert.equal(clampGramSize(9), 6);
  assert.equal(clampGramSize(Number.NaN), 4);
});

test("高頻片段：默認忽略，可關閉，並列出被忽略的片段（原文字形）", () => {
  const tails = ["甲乙丙丁戊", "己庚辛壬癸", "子丑寅卯辰", "巳午未申酉", "戌亥金木水", "火土日月星", "山川河海江", "東南西北中"];
  // 八條都以同一句紀年開頭，其餘文字各不相同。
  const docs = tails.map((tail, index) => ({ id: `d${index}`, text: `崇禎十七年三月十九日，京師陷。${tail}` }));
  const filtered = new SimilarityIndex(docs);
  assert.equal(filtered.ignoreFrequentFragments, true);
  assert.equal(filtered.findAllPairs().length, 0);
  assert.ok(filtered.frequentFragments.length > 0);
  assert.equal(filtered.frequentFragments[0].entryCount, 8);
  assert.ok(filtered.frequentFragments.some((fragment) => fragment.text === "崇禎十七"));

  const unfiltered = new SimilarityIndex(docs, { ignoreFrequentFragments: false });
  assert.equal(unfiltered.findAllPairs().length, 28);
  assert.equal(unfiltered.frequentFragments.length, filtered.frequentFragments.length);
});

test("最少共有字數可調；全庫相似對每對只列一次並按相似度排序", () => {
  const shared = "君父之仇不共戴天闖賊手毒";
  const docs = [
    { id: "a", text: `${shared}甲乙丙丁戊己庚` },
    { id: "b", text: `子丑寅卯${shared}` },
    { id: "c", text: `${shared}辰巳午未申酉戌亥金木水火土` },
  ];
  assert.equal(new SimilarityIndex(docs, { minSharedChars: 12 }).findAllPairs().length, 3);
  assert.equal(new SimilarityIndex(docs, { minSharedChars: 15 }).findAllPairs().length, 0);
  const pairs = new SimilarityIndex(docs).findAllPairs();
  const keys = pairs.map((pair) => [pair.aId, pair.bId].sort().join("-"));
  assert.deepEqual([...keys].sort(), ["a-b", "a-c", "b-c"]);

  // 長文重複引用同一短句時，共有字數按較少的一方計，兩邊看結果一致。
  const repeatedDocs = [
    { id: "long", text: "君父之仇不共戴天甲乙丙丁君父之仇不共戴天戊己庚辛君父之仇不共戴天" },
    { id: "short", text: "子丑君父之仇不共戴天寅卯辰巳午未" },
  ];
  const repeated = new SimilarityIndex(repeatedDocs, { minSharedChars: 10 });
  assert.equal(repeated.findSimilar("long").length, 0);
  assert.equal(repeated.findSimilar("short").length, 0);
  const loose = new SimilarityIndex(repeatedDocs, { minBlockChars: 8, minSharedChars: 8 });
  assert.equal(loose.findSimilar("long")[0].sharedChars, 8);
  assert.equal(loose.findSimilar("short")[0].sharedChars, 8);
  for (let index = 1; index < pairs.length; index += 1) {
    assert.ok(pairs[index - 1].match.score >= pairs[index].match.score);
  }
});

test("片段次序被打亂時，語序一致度下降", () => {
  const shuffled = "欲與明朝共保山河永綏福祿中國臣民不聞加遺一矢君父之仇不共戴天闖賊手毒君親";
  const index = new SimilarityIndex([
    { id: "source", text: SOURCE },
    { id: "shuffled", text: shuffled },
  ]);
  const [match] = index.findSimilar("source");
  assert.equal(match.entryId, "shuffled");
  assert.ok(match.orderConsistency < 0.8);
});

test("語序一致度下限：默認不限，設定後排除次序打亂的條目", () => {
  const abridged = "攝政王致書史可法曰君父之仇不共戴天闖賊手毒君親中國臣民不聞加遺一矢欲與明朝共保山河永綏福位";
  const shuffled = "欲與明朝共保山河永綏福祿中國臣民不聞加遺一矢君父之仇不共戴天闖賊手毒君親";
  const docs = [
    { id: "source", text: SOURCE },
    { id: "abridged", text: abridged },
    { id: "shuffled", text: shuffled },
  ];
  const ids = (index) => index.findSimilar("source").map((match) => match.entryId).sort();

  const unlimited = new SimilarityIndex(docs);
  assert.equal(unlimited.minOrderConsistency, 0);
  assert.deepEqual(ids(unlimited), ["abridged", "shuffled"]);

  // 從哪一條看，同一對的語序一致度都相同（有重複片段時也是）。
  const repeated = new SimilarityIndex(
    [
      { id: "x", text: "君父之仇不共戴天君父之仇闖賊手毒中國臣民" },
      { id: "y", text: "闖賊手毒君父之仇不共戴天中國臣民闖賊手毒" },
    ],
    { minBlockChars: 4, minSharedChars: 4 },
  );
  assert.equal(
    repeated.findSimilar("x")[0].orderConsistency,
    repeated.findSimilar("y")[0].orderConsistency,
  );
  const fromSource = unlimited.findSimilar("source").find((match) => match.entryId === "shuffled");
  const fromShuffled = unlimited.findSimilar("shuffled").find((match) => match.entryId === "source");
  assert.equal(fromSource.orderConsistency, fromShuffled.orderConsistency);

  const strict = new SimilarityIndex(docs, { minOrderConsistency: 0.8 });
  assert.deepEqual(ids(strict), ["abridged"]);
  assert.equal(strict.findAllPairs().some((pair) => [pair.aId, pair.bId].includes("shuffled")), false);

  // 共有片段太少、無法判斷語序時不因下限被排除。
  const short = new SimilarityIndex(
    [
      { id: "a", text: "君父之仇甲乙丙丁" },
      { id: "b", text: "子丑君父之仇寅卯" },
    ],
    { minBlockChars: 4, minSharedChars: 4, minOrderConsistency: 0.9 },
  );
  assert.equal(short.findSimilar("a")[0]?.orderConsistency, null);
  assert.equal(short.findSimilar("a")[0]?.entryId, "b");

  assert.equal(clampMinOrderConsistency(-1), 0);
  assert.equal(clampMinOrderConsistency(2), 1);
  assert.equal(clampMinOrderConsistency(Number.NaN), 0);
});

// 不與其他測試文字重字的填充文字。
const FILLER_A = "春夏秋冬東南西北金木水火土日月星辰山川草木";
const FILLER_B = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥";

test("局部對齊：異文密集仍連成一段，並給出段內一致率", () => {
  const original = "天下大亂兵戈四起民不聊生盜賊蜂起官軍無功";
  const variant = [...original].map((char, index) => (index % 4 === 3 ? "某" : char)).join("");
  const blocks = alignTexts(original, variant, { gramSize: 3 });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].matches, 15);
  assert.ok(blocks[0].identity > 0.75 && blocks[0].identity < 0.85);
  // 片段長度 4 時沒有任何共有的 4 字片段，無從起對。
  assert.equal(alignTexts(original, variant, { gramSize: 4 }).length, 0);
});

test("局部對齊：長文中引用的一段可單獨對出；中間插入過長即分成兩段", () => {
  const passage = "君父之仇不共戴天闖賊手毒君親中國臣民不聞加遺一矢";
  const long = `${FILLER_A}${passage}${FILLER_B}`;
  const [block] = alignTexts(long, passage);
  assert.equal(block.matches, [...passage].length);
  assert.equal(block.aStart, [...FILLER_A].length);
  assert.equal(block.bStart, 0);

  // 中間插入 20 個不相干的字（超過 12 字），分成前後兩段，次序一致。
  const interrupted = `君父之仇不共戴天闖賊手毒${FILLER_B}君親中國臣民不聞加遺一矢`;
  const blocks = alignTexts(passage, interrupted);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].aEnd <= blocks[1].aStart && blocks[0].bEnd <= blocks[1].bStart);
  // 插入少於 12 字時仍是一段，只是一致率下降。
  const short = alignTexts(passage, "君父之仇不共戴天闖賊手毒甲乙丙君親中國臣民不聞加遺一矢");
  assert.equal(short.length, 1);
  assert.ok(short[0].identity < 1);
});

test("局部對齊：結果與兩段的先後無關", () => {
  const left = `${FILLER_A}君父之仇不共戴天闖賊手毒君親中國臣民`;
  const right = `闖賊手毒君親中國臣民${FILLER_B}君父之仇不共戴天闖賊手毒`;
  const forward = alignTexts(left, right, { minBlockChars: 4 });
  const backward = alignTexts(right, left, { minBlockChars: 4 });
  assert.deepEqual(
    forward.map((block) => [block.aStart, block.aEnd, block.bStart, block.bEnd]),
    backward
      .map((block) => [block.bStart, block.bEnd, block.aStart, block.aEnd])
      .sort((x, y) => x[0] - y[0] || x[2] - y[2]),
  );
});

test("每段至少字數與合計字數分開設定：零散短句須調低每段門檻才列出", () => {
  const a = `太監王承恩碑文${FILLER_A}莊烈愍皇帝${FILLER_B}孤立於上視死如歸`;
  const b = `記太監王承恩碑文事曰莊烈愍皇帝在位十七年孤立於上而視死如歸`;
  const docs = [
    { id: "a", text: a },
    { id: "b", text: b },
  ];
  assert.equal(new SimilarityIndex(docs).findSimilar("a").length, 0);
  const loose = new SimilarityIndex(docs, { minBlockChars: 4, minSharedChars: 10 });
  const [match] = loose.findSimilar("a");
  assert.equal(match.entryId, "b");
  assert.ok(match.blocks.length >= 3);
  assert.equal(match.orderConsistency, 1);
  // 合計門檻高於共有字數時不列出。
  assert.equal(new SimilarityIndex(docs, { minBlockChars: 4, minSharedChars: 30 }).findSimilar("a").length, 0);
});

test("比勘只比對齊段落：段落外的文字不參與比較，找不到段落時退回全文", () => {
  const passage = "君父之仇不共戴天闖賊手毒君親中國臣民不聞加遺一矢";
  const long = `${FILLER_A}${passage.replace("毒", "害")}${FILLER_B}`;
  const result = compareTexts(long, passage, false, {});
  assert.equal(result.blocks.length, 1);
  const fillerLength = [...FILLER_A].length;
  assert.equal(result.leftOutside[0], 1);
  assert.equal(result.leftOutside[fillerLength], 0);
  assert.equal(result.rightOutside.every((value) => value === 0), true);
  // 段落外的文字不會被當成異文。
  assert.equal(result.hunks.length, 1);
  assert.equal(result.equalChars, [...passage].length - 1);

  const whole = compareTexts(long, passage);
  assert.equal(whole.blocks, null);
  assert.ok(whole.hunks.length >= 2);

  const none = compareTexts(FILLER_A, FILLER_B, false, {});
  assert.deepEqual(none.blocks, []);
});

test("分段門檻與繁簡歸一可調", () => {
  const passage = "君父之仇不共戴天闖賊手毒君親中國臣民不聞加遺一矢";
  const interrupted = `君父之仇不共戴天闖賊手毒${FILLER_B}君親中國臣民不聞加遺一矢`;
  // 插入 24 字：默認 12 字即分段，放寬到 30 字則仍是一段。
  assert.equal(alignTexts(passage, interrupted).length, 2);
  assert.equal(alignTexts(passage, interrupted, { maxGap: 30 }).length, 1);

  const traditional = "爲明復仇說之甚詳君父之讎不共戴天";
  const simplified = "为明复仇说之甚详君父之讎不共戴天";
  assert.equal(alignTexts(traditional, simplified)[0].matches, 16);
  // 區分繁簡時，爲/为、復/复、說/说、詳/详 都算異文。
  const strict = alignTexts(traditional, simplified, { strict: true, minBlockChars: 4 });
  assert.equal(strict.reduce((sum, block) => sum + block.matches, 0) < 16, true);
  const index = new SimilarityIndex(
    [
      { id: "t", text: traditional },
      { id: "s", text: simplified },
    ],
    { strict: true },
  );
  assert.equal(index.strict, true);
  assert.ok((index.findSimilar("t")[0]?.sharedChars ?? 0) < 16);
});

test("段首段尾短於片段長度的相同字：比相隔的差異長才算入段落", () => {
  // 「處死五條」與「處死凡五條」：「五條」只隔一個衍字，屬於同一段。
  const [block] = alignTexts(`${FILLER_A}大逆凌遲處死五條${FILLER_B}`, "大逆凌遲處死凡五條", { minBlockChars: 8 });
  assert.equal(block.matches, 8);
  assert.equal(block.aEnd - block.aStart, 8);
  assert.equal(block.bEnd - block.bStart, 9);
  // 隔著三個異文才碰上的一個「條」，多半是巧合，不算入。
  const [loose] = alignTexts("大逆凌遲處死甲乙丙條", "大逆凌遲處死凡五條", { minBlockChars: 4 });
  assert.equal(loose.matches, 6);
  assert.equal(loose.aEnd, 6);
});

const LEFT_EDICT = "署刑部朱之臣再擬六等，請命絞罪以上提問，流罪以下撫按究報。計大逆凌遲處死五條，絞六條，流二條，徒二條。";
const RIGHT_EDICT =
  "三法司奏定從逆六等條例。大逆凌遲處死凡五條：凡從賊攻陷京師及為賊毀宗社、易門榜者，凡倡率勸進及為賊草偽詔者。" +
  "上曰：所奏既已會議允當，並先奪職。其絞罪以上，三法司行撫按官逮至京訊之；流罪以下，撫按官依律即訊具奏。";

// 標爲相同的字（比較時已按繁簡歸一，期望值也要歸一）。
function sameText(comparable, marks, outside) {
  return comparable.tokens.filter((_, index) => !marks[index] && !(outside && outside[index])).join("");
}
const fold = (text) => toComparableText(text).tokens.join("");

test("比全文：次序顛倒的兩處都標爲相同，且包含只比段落時所見", () => {
  const aligned = compareTexts(LEFT_EDICT, RIGHT_EDICT, false, {});
  // 「大逆凌遲處死凡五條」只有 8 字相同，未達每段 10 字，不成對齊段落。
  assert.equal(aligned.blocks.length, 1);
  assert.equal(sameText(aligned.left, aligned.leftMarks, aligned.leftOutside), fold("絞罪以上流罪以下撫按"));

  // 舊的做法整條按先後比較，兩處次序顛倒，只能對上其中一處。
  const sequential = compareTexts(LEFT_EDICT, RIGHT_EDICT);
  assert.equal(sameText(sequential.left, sequential.leftMarks).includes(fold("流罪以下撫按")), false);

  const whole = compareTexts(LEFT_EDICT, RIGHT_EDICT, false, {}, true);
  assert.equal(whole.blocks.length, 1);
  assert.equal(whole.leftOutside, null);
  const leftSame = sameText(whole.left, whole.leftMarks, null);
  assert.ok(leftSame.includes(fold("絞罪以上流罪以下撫按")));
  assert.ok(leftSame.includes(fold("大逆凌遲處死五條")));
  whole.left.tokens.forEach((_, index) => {
    if (!aligned.leftMarks[index] && !aligned.leftOutside[index]) {
      assert.equal(whole.leftMarks[index], 0);
    }
  });
  // 數字與標記一致：相同字數等於兩側未標爲不同的字數。
  const unmarked = (marks) => marks.length - marks.reduce((sum, value) => sum + value, 0);
  assert.equal(whole.equalChars, unmarked(whole.leftMarks));
  assert.equal(whole.equalChars, unmarked(whole.rightMarks));
});

test("比全文：段落外的異文不跨過對齊段落", () => {
  const first = "君父之仇不共戴天闖賊手毒君親";
  const second = "中國臣民不聞加遺一矢收繫妻子";
  const left = `${first}${FILLER_A}${second}`;
  const right = `${second}${FILLER_B}${first}`;
  const whole = compareTexts(left, right, false, {}, true);
  assert.equal(whole.blocks.length, 2);
  for (const block of whole.blocks) {
    for (let index = block.aStart; index < block.aEnd; index += 1) {
      assert.equal(whole.leftMarks[index], 0);
    }
    for (let index = block.bStart; index < block.bEnd; index += 1) {
      assert.equal(whole.rightMarks[index], 0);
    }
  }
  for (const hunk of whole.hunks) {
    for (const block of whole.blocks) {
      const crossesA = hunk.aStart < block.aEnd && block.aStart < hunk.aEnd;
      const crossesB = hunk.bStart < block.bEnd && block.bStart < hunk.bEnd;
      assert.equal(crossesA, false);
      assert.equal(crossesB, false);
    }
  }
});

// 跨索引沿用的對齊結果：改動一條後，結果須與清空快取重算的完全一致。
test("相似索引：改動一條後沿用其餘配對，結果與從頭計算相同", () => {
  const base = [
    { id: "a", text: "署刑部朱之臣再擬六等，請命絞罪以上提問，流罪以下撫按究報。計大逆凌遲處死五條，絞六條。" },
    { id: "b", text: "三法司奏定從逆六等條例。大逆凌遲處死凡五條。其絞罪以上，三法司行撫按官逮至京訊之；流罪以下，撫按官依律即訊具奏。" },
    { id: "c", text: "工科左李維樾言：從逆一案，經侍郎臣朱之臣擬議，嚴且盡矣，然逆之一字，未可概施。" },
    { id: "d", text: "李維樾言從逆一案經侍郎朱之臣擬議嚴且盡矣然逆之一字未可概施導賊略地攻城是逆。" },
  ];
  const options = { gramSize: 4, minBlockChars: 6, minSharedChars: 6 };
  const plain = (pairs) => JSON.stringify(pairs);

  clearSimilarityCaches();
  const first = new SimilarityIndex(base, options).findAllPairs();
  assert.ok(first.length >= 2);

  const edited = base.map((doc) => (doc.id === "c" ? { ...doc, text: doc.text.replace("嚴且盡矣", "已嚴矣") } : doc));
  const cached = new SimilarityIndex(edited, options).findAllPairs();
  clearSimilarityCaches();
  const fresh = new SimilarityIndex(edited, options).findAllPairs();
  assert.equal(plain(cached), plain(fresh));

  // 規則改變時不沿用舊結果。
  const stricter = { ...options, minBlockChars: 12 };
  const afterRules = new SimilarityIndex(edited, stricter).findAllPairs();
  clearSimilarityCaches();
  assert.equal(plain(afterRules), plain(new SimilarityIndex(edited, stricter).findAllPairs()));

  // 刪去的條目不再出現在結果中。
  const removed = new SimilarityIndex(edited.filter((doc) => doc.id !== "d"), options).findAllPairs();
  assert.ok(removed.every((pair) => pair.aId !== "d" && pair.bId !== "d"));
});
