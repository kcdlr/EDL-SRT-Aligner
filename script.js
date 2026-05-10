/* =============================================
   EDL-SRT Aligner
   ---------------------------------------------
   • 完全一致モード（EDL優先） (strictAlign)
   • 最小編集モード (minimalAlign)
   ---------------------------------------------
   すべてクライアントサイドで完結
   ============================================= */

const logBox = document.getElementById('log');
const ONE_MS = 0.001; // 秒単位の 1ms (オフセット処理で使用)

//------------------------------------------------
// 共通ユーティリティ
//------------------------------------------------
const log = txt => { logBox.textContent += txt + '\n'; };
const clearLog = () => logBox.textContent = '';
const readFileText = file => file.text();
const pad = (n, l = 2) => String(n).padStart(l, '0');

function srtTimeToSec(str) { // "HH:MM:SS,mmm" → 秒
  const [hms, ms] = str.split(',');
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + +s + (+ms) / 1000;
}
function secToSrtTime(sec) {
  const H = Math.floor(sec / 3600);
  const M = Math.floor(sec % 3600 / 60);
  const S = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${pad(H)}:${pad(M)}:${pad(S)},${pad(ms, 3)}`;
}

//------------------------------------------------
// EDL & SRT 解析
//------------------------------------------------
function parseEDL(text, fps) {
  const re = /\d{2}:\d{2}:\d{2}:\d{2}/g;
  const cuts = new Set();
  text.split(/\r?\n/).forEach(line => {
    const m = line.match(re);
    if (m && m.length === 4) { cuts.add(m[2]); cuts.add(m[3]); }
  });
  return [...cuts].sort().map(tcStr => {
    const [H, M, S, F] = tcStr.split(':').map(Number);
    return H * 3600 + M * 60 + S + F / fps; // 秒 (float)
  });
}

function parseSRT(text) {
  return text.replace(/\r/g, '').trim().split('\n\n').map(block => {
    const lines = block.split('\n');
    const [st, ed] = lines[1].split(' --> ');
    return {
      index: +lines[0],
      start: srtTimeToSec(st),
      end: srtTimeToSec(ed),
      content: lines.slice(2).join('\n')
    };
  });
}

function composeSRT(subs) {
  return subs.map(s =>
    `${s.index}\n${secToSrtTime(s.start)} --> ${secToSrtTime(s.end)}\n${s.content}\n`
  ).join('\n');
}

//------------------------------------------------
// ① 完全一致モード（EDL優先）
//------------------------------------------------
function strictAlign(subs, cuts) {
  if (cuts.length < 2) {
    log('⚠️ カット点が2つ未満のため、クリップを形成できません。');
    return [];
  }
  cuts.sort((a, b) => a - b);
  const alignedSubs = [];
  const edlClips = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    edlClips.push({ start: cuts[i], end: cuts[i + 1] });
  }

  // 各EDLクリップに対して、最もズレが小さいSRTクリップを紐付ける
  edlClips.forEach(clip => {
    let bestMatchSub = null;
    let minScore = Infinity;

    subs.forEach(sub => {
      const score = Math.abs(sub.start - clip.start) + Math.abs(sub.end - clip.end);
      if (score < minScore) {
        minScore = score;
        bestMatchSub = sub;
      }
    });

    // 最も見つかった場合は、その字幕内容を使って新しいクリップを作成
    if (bestMatchSub) {
      alignedSubs.push({
        ...bestMatchSub, // contentと他のプロパティをコピー
        start: clip.start, // 時間はEDLクリップに合わせる
        end: clip.end
      });
    }
  });

  // 開始時間でソートして、インデックスを振り直す
  return alignedSubs
    .sort((a, b) => a.start - b.start)
    .map((sub, index) => ({
      ...sub,
      index: index + 1
    }));
}

//------------------------------------------------
// ② 最小編集モード (ONE_MSの利用箇所を修正)
//------------------------------------------------
function buildOneToOneMap(subs, cuts) {
  const cand = [];
  subs.forEach((sub, si) => {
    const ci = cuts.reduce((best, val, idx) =>
      Math.abs(val - sub.start) < Math.abs(cuts[best] - sub.start) ? idx : best, 0);
    const dist = Math.abs(cuts[ci] - sub.start);
    cand.push([dist, si, ci]);
  });
  cand.sort((a, b) => a[0] - b[0]);
  const sub2cut = Array(subs.length).fill(null);
  const cutOwner = new Map();
  cand.forEach(([dist, si, ci]) => {
    if (!cutOwner.has(ci)) {
      sub2cut[si] = ci;
      cutOwner.set(ci, [si, dist]);
    } else {
      const [prevSi, prevDist] = cutOwner.get(ci);
      if (dist < prevDist) {
        sub2cut[prevSi] = null;
        sub2cut[si] = ci;
        cutOwner.set(ci, [si, dist]);
      }
    }
  });
  return sub2cut;
}

function minimalAlign(subs, cuts) {
  const sub2cut = buildOneToOneMap(subs, cuts);
  const out = [];
  let prevEnd = null;
  subs.forEach((sub, i) => {
    const ci = sub2cut[i];
    const matchedCut = ci !== null ? cuts[ci] : null;
    const newStart = (i === 0)
      ? (matchedCut !== null ? matchedCut : sub.start)
      : prevEnd;

    let newEnd;
    if (i + 1 < subs.length) {
      const nextCi = sub2cut[i + 1];
      if (nextCi !== null)
        newEnd = cuts[nextCi]; // ★★★ ONE_MSの加算を削除 ★★★
      else
        newEnd = newStart + (sub.end - sub.start);
    } else {
      newEnd = newStart + (sub.end - sub.start);
    }
    // ゼロ/負のデュレーションを防ぐための安全装置は残す
    if (newEnd <= newStart) newEnd = newStart + ONE_MS;

    prevEnd = newEnd;
    out.push({ ...sub, start: newStart, end: newEnd });
  });
  return out;
}

//------------------------------------------------
// メイン (オフセット処理を追加)
//------------------------------------------------
async function run() {
  clearLog();
  const edlFile = document.getElementById('edlFile').files[0];
  const srtFile = document.getElementById('srtFile').files[0];
  const fps = parseFloat(document.getElementById('fpsInput').value) || 60;
  const mode = document.querySelector('input[name="mode"]:checked').value;
  // ★★★ オフセットオプションを読み込む ★★★
  const applyOffset = document.getElementById('offsetCheckbox').checked;

  if (!edlFile || !srtFile) { alert('EDL と SRT の両方を選択してください'); return; }
  log(`FPS: ${fps}`);

  const [edlTxt, srtTxt] = await Promise.all([readFileText(edlFile), readFileText(srtFile)]);
  const cuts = parseEDL(edlTxt, fps);
  const subs = parseSRT(srtTxt);

  log(`カット点   : ${cuts.length}`);
  log(`字幕行数   : ${subs.length}`);
  log(`モード     : ${mode === 'strict' ? '完全一致（EDL優先）' : '最小編集'}`);
  log(`1msオフセット: ${applyOffset ? '有効' : '無効'}`); // ログ表示

  // Step 1: モードに応じてアライメント処理を実行
  const alignedSubs = (mode === 'strict') ? strictAlign(subs, cuts)
    : minimalAlign(subs, cuts);

  // Step 2: ★★★ オフセットが有効な場合、全字幕の時間をずらす ★★★
  const offset = applyOffset ? ONE_MS : 0;
  const finalSubs = alignedSubs.map(sub => ({
    ...sub,
    start: sub.start + offset,
    end: sub.end + offset
  }));

  // Step 3: 最終結果をSRTファイルとして構成・ダウンロード
  const result = composeSRT(finalSubs);
  download(result, 'aligned_output.srt');
  log('✅ 処理が完了しました。');
}

function download(content, filename) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

//------------------------------------------------
// イベント
//------------------------------------------------
document.getElementById('runBtn').addEventListener('click', run);
