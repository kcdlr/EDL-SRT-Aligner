/* =============================================
   EDL-SRT Aligner
   ---------------------------------------------
   • クリップ数一致モード (strictAlign)
   • 編集点合わせモード (minimalAlign)
   ---------------------------------------------
   すべてクライアントサイドで完結
   ============================================= */

const logBox = document.getElementById('log');
const ONE_MS = 0.001; // 秒単位の 1ms (オフセット処理で使用)
const BOUNDARY_MERGE_TOLERANCE = 0.002; // 同じ字幕境界として扱う許容差
const MAX_CUT_SNAP_DISTANCE = 1.0; // EDLカットへ寄せる最大距離（秒）

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
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const H = Math.floor(totalMs / 3600000);
  const M = Math.floor(totalMs % 3600000 / 60000);
  const S = Math.floor(totalMs % 60000 / 1000);
  const ms = totalMs % 1000;
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
// ① クリップ数一致モード
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
// ② 編集点合わせモード
//------------------------------------------------
function buildSubtitleBoundaryGroups(subs) {
  const points = [];
  subs.forEach((sub, index) => {
    points.push({ time: sub.start, ref: { index, edge: 'start' } });
    points.push({ time: sub.end, ref: { index, edge: 'end' } });
  });

  points.sort((a, b) => a.time - b.time);

  const groups = [];
  points.forEach(point => {
    const last = groups[groups.length - 1];
    if (last && Math.abs(point.time - last.time) <= BOUNDARY_MERGE_TOLERANCE) {
      last.refs.push(point.ref);
      last.timeSum += point.time;
      last.time = last.timeSum / last.refs.length;
    } else {
      groups.push({
        time: point.time,
        timeSum: point.time,
        refs: [point.ref],
        target: null
      });
    }
  });

  return groups;
}

function matchBoundariesToCuts(boundaryGroups, cuts) {
  const sortedCuts = [...cuts].sort((a, b) => a - b);
  let cutStartIndex = 0;
  let matchCount = 0;

  boundaryGroups.forEach(group => {
    let bestCutIndex = -1;
    let bestDistance = Infinity;

    while (
      cutStartIndex < sortedCuts.length &&
      sortedCuts[cutStartIndex] < group.time - MAX_CUT_SNAP_DISTANCE
    ) {
      cutStartIndex++;
    }

    for (let i = cutStartIndex; i < sortedCuts.length; i++) {
      const cut = sortedCuts[i];
      if (cut > group.time + MAX_CUT_SNAP_DISTANCE) break;

      const distance = Math.abs(cut - group.time);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestCutIndex = i;
      }
    }

    if (bestCutIndex !== -1) {
      group.target = sortedCuts[bestCutIndex];
      cutStartIndex = bestCutIndex + 1;
      matchCount++;
    }
  });

  return matchCount;
}

function minimalAlign(subs, cuts) {
  if (subs.length === 0 || cuts.length === 0) return subs;

  const out = subs.map(sub => ({ ...sub }));
  const boundaryGroups = buildSubtitleBoundaryGroups(subs);
  const matchCount = matchBoundariesToCuts(boundaryGroups, cuts);

  boundaryGroups.forEach(group => {
    if (group.target === null) return;

    group.refs.forEach(ref => {
      out[ref.index][ref.edge] = group.target;
    });
  });

  out.forEach(sub => {
    if (sub.end <= sub.start) sub.end = sub.start + ONE_MS;
  });

  log(`編集点合わせ: ${matchCount}箇所の字幕境界をEDLカットに合わせました。`);
  return out.map((sub, index) => ({ ...sub, index: index + 1 }));
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
  log(`モード     : ${mode === 'strict' ? 'クリップ数一致' : '編集点合わせ'}`);
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
