/* =============================================
   EDL-SRT Aligner
   ---------------------------------------------
   • 完全一致モード  (strictAlign)
   • 最小編集モード (minimalAlign)
   ---------------------------------------------
   すべてクライアントサイドで完結
   ============================================= */

const logBox = document.getElementById('log');
const ONE_MS = 0.001;            // 秒単位の 1ms

//------------------------------------------------
// 共通ユーティリティ
//------------------------------------------------
const log = txt => { logBox.textContent += txt + '\n'; };
const clearLog = () => logBox.textContent = '';

const readFileText = file => file.text();          // File → Promise<string>

const pad = (n,l=2) => String(n).padStart(l,'0');

function srtTimeToSec(str){                        // "HH:MM:SS,mmm" → 秒
  const [hms,ms] = str.split(',');
  const [h,m,s]  = hms.split(':').map(Number);
  return h*3600 + m*60 + +s + (+ms)/1000;
}
function secToSrtTime(sec){
  const H=Math.floor(sec/3600);
  const M=Math.floor(sec%3600/60);
  const S=Math.floor(sec%60);
  const ms=Math.round((sec-Math.floor(sec))*1000);
  return `${pad(H)}:${pad(M)}:${pad(S)},${pad(ms,3)}`;
}

//------------------------------------------------
// EDL & SRT 解析
//------------------------------------------------
function parseEDL(text, fps){
  const re   = /\d{2}:\d{2}:\d{2}:\d{2}/g;
  const cuts = new Set();
  text.split(/\r?\n/).forEach(line=>{
    const m = line.match(re);
    if(m && m.length===4){ cuts.add(m[2]); cuts.add(m[3]); }
  });
  return [...cuts].sort().map(tcStr => {
    const [H,M,S,F] = tcStr.split(':').map(Number);
    return H*3600 + M*60 + S + F/fps;               // 秒 (float)
  });
}

function parseSRT(text){
  return text.replace(/\r/g,'').trim().split('\n\n').map(block=>{
    const lines = block.split('\n');
    const [st,ed] = lines[1].split(' --> ');
    return {
      index  : +lines[0],
      start  : srtTimeToSec(st),
      end    : srtTimeToSec(ed),
      content: lines.slice(2).join('\n')
    };
  });
}

function composeSRT(subs){
  return subs.map(s=>
    `${s.index}\n${secToSrtTime(s.start)} --> ${secToSrtTime(s.end)}\n${s.content}\n`
  ).join('\n');
}

//------------------------------------------------
// ① 完全一致モード
//------------------------------------------------
function strictAlign(subs, cuts){
  if (cuts.length === 0) return subs;

  const aligned = [];
  cuts.sort((a,b)=>a-b);
  // 各字幕開始点を「一番近いカット点」に合わせる
  const nearest = t => cuts.reduce((a,b)=>Math.abs(b-t)<Math.abs(a-t)?b:a, cuts[0]);

  subs.forEach((sub,i)=>{
    const newStart = (i===0) ? nearest(sub.start) : aligned[i-1].end;
    let newEnd;
    if(i+1 < subs.length){
      const baseEnd = nearest(subs[i+1].start);
      newEnd = baseEnd + ONE_MS;
    }else{
      newEnd = newStart + (sub.end - sub.start);
    }
    if(newEnd<=newStart) newEnd=newStart+ONE_MS;
    aligned.push({...sub,start:newStart,end:newEnd});
  });
  return aligned;
}

//------------------------------------------------
// ② 最小編集モード
//------------------------------------------------
function minimalAlign(subs, cuts){
  /* ---- 1:1 マッチング (greedy) ---- */
  const cand=[];
  subs.forEach((sub,si)=>{
    const ci = cuts.reduce((best,i,idx)=>
      Math.abs(i-sub.start)<Math.abs(cuts[best]-sub.start)?idx:best,0);
    cand.push([Math.abs(cuts[ci]-sub.start), si, ci]);
  });
  cand.sort((a,b)=>a[0]-b[0]);

  const sub2cut = Array(subs.length).fill(null);
  const cutTaken = new Set();
  cand.forEach(([d,si,ci])=>{
    if(!cutTaken.has(ci)){ sub2cut[si]=ci; cutTaken.add(ci); }
  });

  /* ---- タイムライン再構築 ---- */
  const out = [];
  subs.forEach((sub,i)=>{
    const ci = sub2cut[i];
    const newStart = (i===0)
        ? (ci!==null ? cuts[ci] : sub.start)
        : out[i-1].end;

    let newEnd;
    if(i+1<subs.length){
      const nextCi = sub2cut[i+1];
      if(nextCi!==null) newEnd = cuts[nextCi] + ONE_MS;
      else              newEnd = newStart + (sub.end - sub.start);
    } else {
      newEnd = newStart + (sub.end - sub.start);
    }
    if(newEnd<=newStart) newEnd=newStart+ONE_MS;

    out.push({...sub,start:newStart,end:newEnd});
  });
  return out;
}

//------------------------------------------------
// メイン
//------------------------------------------------
async function run(){
  clearLog();
  const edlFile = document.getElementById('edlFile').files[0];
  const srtFile = document.getElementById('srtFile').files[0];
  const fps     = parseFloat(document.getElementById('fpsInput').value)||60;
  const mode    = document.querySelector('input[name="mode"]:checked').value;

  if(!edlFile || !srtFile){ alert('EDL と SRT の両方を選択してください'); return; }
  log(`FPS: ${fps}`);

  const [edlTxt, srtTxt] = await Promise.all([readFileText(edlFile), readFileText(srtFile)]);
  const cuts = parseEDL(edlTxt, fps);
  const subs = parseSRT(srtTxt);

  log(`カット点  : ${cuts.length}`);
  log(`字幕行数  : ${subs.length}`);
  log(`モード    : ${mode === 'strict' ? '完全一致' : '最小編集'}`);

  const newSubs = (mode === 'strict') ? strictAlign(subs, cuts)
                                      : minimalAlign(subs, cuts);

  const result  = composeSRT(newSubs);
  download(result, 'aligned_output.srt');
  log('✅ 処理が完了しました。');
}

function download(content, filename){
  const blob = new Blob([content],{type:'text/plain'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href=url; a.download=filename; a.click();
  URL.revokeObjectURL(url);
}

//------------------------------------------------
// イベント
//------------------------------------------------
document.getElementById('runBtn').addEventListener('click', run);
