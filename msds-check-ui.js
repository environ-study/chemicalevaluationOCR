/* ============================================================
   msds-check-ui.js — MSDS 업로드 정합성 검사 화면
   ─────────────────────────────────────────────────────────
   msds-check.js(MsdsCheck)의 검사 결과를 카드로 그리고, 판독한
   3번 구성성분을 기존 "직접입력 시트"(app.js addMsdsSheet/addManualRow)로
   보낸다. 파일은 브라우저 밖으로 전송되지 않는다.
   ============================================================ */

const msdsCheckResults = []; // 업로드 순서대로 검사 결과 보관

function initMsdsUpload() {
  const drop = document.getElementById('msdsDrop');
  const input = document.getElementById('msdsFileInput');
  if (!drop || !input) return;

  input.addEventListener('change', () => {
    handleMsdsFiles([...input.files]);
    input.value = '';
  });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
  }));
  drop.addEventListener('drop', (e) => handleMsdsFiles([...(e.dataTransfer.files || [])]));
}

const MSDS_ACCEPT_RE = /\.(pdf|jpe?g|png)$/i;

async function handleMsdsFiles(files) {
  const list = files.filter((f) => MSDS_ACCEPT_RE.test(f.name));
  if (!list.length) {
    alert('PDF 또는 JPG/PNG 파일을 선택하세요.');
    return;
  }
  // "이미지 여러 장을 한 MSDS로" 선택 시: 이미지는 파일명 순으로 묶어 1건, PDF는 각각 1건
  const merge = document.getElementById('msdsMergeImages');
  const images = list.filter((f) => !/\.pdf$/i.test(f.name));
  const jobs = [];
  if (merge && merge.checked && images.length > 1) {
    list.filter((f) => /\.pdf$/i.test(f.name)).forEach((f) => jobs.push([f]));
    jobs.push(images.slice().sort((x, y) => x.name.localeCompare(y.name, 'ko', { numeric: true })));
  } else {
    list.forEach((f) => jobs.push([f]));
  }

  const area = document.getElementById('msdsCheckArea');
  const statusEl = document.getElementById('msdsCheckStatus');

  for (const job of jobs) {
    const label = job.map((f) => f.name).join(' + ');
    const idx = msdsCheckResults.length;
    msdsCheckResults.push(null);
    const holder = document.createElement('div');
    holder.id = 'msdsCheck-' + idx;
    holder.className = 'card msds-check-card';
    holder.innerHTML = `<div class="card-head">📄 ${escHtml(label)}</div>
      <div class="card-body"><div class="mc-progress" id="msdsCheckProg-${idx}">대기 중…</div></div>`;
    area.prepend(holder);

    const setStatus = (t) => {
      const p = document.getElementById('msdsCheckProg-' + idx);
      if (p) p.textContent = t;
      if (statusEl) statusEl.textContent = `${label} — ${t}`;
    };

    try {
      const res = job.length > 1
        ? await MsdsCheck.checkFilesAsOne(job, setStatus)
        : await MsdsCheck.checkFile(job[0], setStatus);
      msdsCheckResults[idx] = res;
      holder.outerHTML = renderMsdsCheck(res, idx);
    } catch (e) {
      console.error(e);
      holder.querySelector('.card-body').innerHTML =
        `<div class="err-box"><strong>⚠️ 판독 실패</strong>${escHtml(e && e.message ? e.message : String(e))}</div>`;
    }
  }
  if (statusEl) statusEl.textContent = '';
}

/* ── 렌더링 ─────────────────────────────────────────────── */
const MC_VERDICT = {
  OK:     { cls: 'verdict-ok',     icon: '✅', label: '정합성 양호' },
  CHECK:  { cls: 'verdict-review', icon: '⚠',  label: '확인 필요' },
  REVIEW: { cls: 'verdict-block',  icon: '⛔', label: '재검토 필요' },
};
const MC_LEVEL_ICON = { ok: '✅', error: '⛔', warn: '⚠', info: 'ℹ️' };

function mcFmtNum(v) {
  return v == null || v === '' ? '' : String(v);
}

function renderMsdsCheck(res, idx) {
  const v = MC_VERDICT[res.verdict] || MC_VERDICT.CHECK;
  const comp = res.composition;
  const reg = res.regulation;
  const srcLabel = res.ocrPages.length
    ? (res.ocrPages.length === res.pageCount ? 'OCR 판독' : `텍스트 + OCR(${res.ocrPages.join(',')}p)`)
    : '텍스트 PDF';

  const summaryRows = [
    mcCheckRow('① 제출번호', res.submission.status,
      res.submission.value ? `<b>${escHtml(res.submission.value)}</b> · ${res.submission.page}p` : '없음',
      res.submission.status === 'ok' && !res.submission.corrected ? '' : escHtml(res.submission.message)),
    mcCheckRow('② 개정일자', res.revision.status === 'ok' ? 'ok' : 'warn',
      res.revision.value ? `<b>${escHtml(res.revision.value)}</b> · ${res.revision.page}p`
        : (res.revision.fallbackValue ? `${escHtml(res.revision.fallbackValue)} (작성·발행일자) · ${res.revision.page}p` : '확인 안 됨'),
      res.revision.status === 'ok'
        ? [res.revision.created ? `작성일자 ${res.revision.created}` : '', res.revision.ambiguous ? escHtml(res.revision.message) : ''].filter(Boolean).join(' · ')
        : escHtml(res.revision.message)),
    mcCheckRow('③ 3번 구성성분', comp.rows.length && !comp.issues.some((i) => i.level !== 'info') ? 'ok' : (comp.rows.length ? 'warn' : 'error'),
      `${comp.rows.length}종 판독${comp.headerFound ? '' : ' (표 머리글 미확인)'}`,
      comp.found ? '' : '3번 제목 미확인 — 문서 전체에서 탐색'),
    mcCheckRow('④ 15번 법적규제', reg.found && reg.laws.length ? (reg.unmatchedCas.length ? 'warn' : 'ok') : 'warn',
      reg.found ? `${reg.laws.length}개 법령 언급` : '항목 미확인',
      reg.laws.filter((l) => l.status === 'regulated').map((l) => escHtml(mcLawShort(l.law))).join(', ')),
  ].join('');

  const issueList = res.issues.filter((i) => i.level !== 'ok');
  const issuesHtml = issueList.length
    ? `<ul class="mc-issues">${issueList.map((i) =>
        `<li class="mc-lv-${i.level}">${MC_LEVEL_ICON[i.level] || ''} <b>${escHtml(i.area || '')}</b> ${escHtml(i.msg)}</li>`).join('')}</ul>`
    : '';

  return `<div class="card msds-check-card" id="msdsCheck-${idx}">
    <div class="card-head">📄 ${escHtml(res.fileName)}
      <span class="sec-badge b-gray" style="margin-left:auto">${res.pageCount}p · ${escHtml(srcLabel)}</span>
    </div>
    <div class="summary-banner ${v.cls}">
      <span class="summary-icon">${v.icon}</span>
      <div class="summary-text">
        <div class="summary-title">${v.label}${res.productName ? ' — ' + escHtml(res.productName) : ''}</div>
      </div>
      <div class="loc-btn-group">
        <button class="loc-btn" onclick="sendMsdsCheckToSheet(${idx})">➡ 직접입력 시트로 보내기</button>
        <button class="loc-btn loc-btn-health" onclick="toggleEl('mcRaw-${idx}')">원문 텍스트</button>
      </div>
    </div>
    <div class="card-body" style="padding-top:8px">
      <table class="reg mc-summary"><tbody>${summaryRows}</tbody></table>
      ${issuesHtml}
      ${renderMcComposition(res, idx)}
      ${renderMcRegulations(res)}
      ${res.missingSections.length
        ? `<div class="mc-note">16개 항목 중 제목을 찾지 못한 항목: ${res.missingSections.join(', ')}번 (양식 차이일 수 있음)</div>`
        : '<div class="mc-note">16개 항목 제목 모두 확인</div>'}
      <pre class="mc-raw" id="mcRaw-${idx}" style="display:none">${escHtml(mcRawText(res))}</pre>
    </div>
  </div>`;
}

function mcCheckRow(label, level, value, note) {
  return `<tr class="mc-lv-${level}">
    <th>${MC_LEVEL_ICON[level] || ''} ${label}</th>
    <td>${value}${note ? `<div class="law-note">${note}</div>` : ''}</td>
  </tr>`;
}

const MC_LAW_SHORT = {
  '산업안전보건법': '산안법',
  '화학물질관리법': '화관법',
  '화학물질의 등록 및 평가 등에 관한 법률': '화평법',
  '위험물안전관리법': '위험물법',
};
function mcLawShort(law) { return MC_LAW_SHORT[law] || law; }

function renderMcComposition(res, idx) {
  const rows = res.composition.rows;
  if (!rows.length) return '<div class="mc-note">3번 구성성분 표를 판독하지 못했습니다. 원문 텍스트를 확인하세요.</div>';
  const body = rows.map((r, i) => {
    const casCls = r.secret ? 'mc-cas-secret' : (r.casValid ? '' : 'mc-cas-bad');
    const casTitle = r.secret ? 'CAS 비공개' : (r.casValid ? 'CAS 체크디지트 정상' : 'CAS 체크디지트 불일치 — 오독 가능');
    const regs = (r.regs || []).map((g) => `<span class="mc-chip" title="${escAttr(g.law)}">${escHtml(mcLawShort(g.law))}·${escHtml(g.item)}</span>`).join('');
    return `<tr>
      <td class="td-num">${i + 1}</td>
      <td class="mc-name">${escHtml(r.name || '-')}${r.alias ? `<div class="law-note">${escHtml(r.alias)}</div>` : ''}</td>
      <td><input class="mc-in mc-cas ${casCls}" id="mc-${idx}-${i}-cas" value="${escAttr(r.cas)}" title="${casTitle}" oninput="onCASInput(this)" maxlength="12"></td>
      <td><input class="mc-in mc-num" id="mc-${idx}-${i}-min" type="number" step="0.01" value="${mcFmtNum(r.min)}"></td>
      <td><input class="mc-in mc-num" id="mc-${idx}-${i}-max" type="number" step="0.01" value="${mcFmtNum(r.max)}"></td>
      <td class="mc-center"><input type="checkbox" id="mc-${idx}-${i}-lt" ${r.isLt ? 'checked' : ''} title="체크 = 미만(최대값 미포함)"></td>
      <td class="mc-raw-cell" title="${escAttr(r.lineText)}">${escHtml(r.contentRaw || '')}</td>
      <td>${regs || '<span class="law-note">-</span>'}</td>
      <td class="mc-center"><input type="checkbox" id="mc-${idx}-${i}-use" ${r.cas && !r.sharedContent ? 'checked' : ''} title="시트로 보낼 행 — 후보군 합계는 개별 함량 확인 필요"></td>
    </tr>`;
  }).join('');
  return `<div class="mc-sub-title">3번 구성성분 (판독값 — 수정 후 시트로 보낼 수 있음)</div>
    <div class="tbl-wrap"><table class="reg mc-comp">
      <thead><tr>
        <th>#</th><th>화학물질명</th><th>CAS</th><th>최소(%)</th><th>최대(%)</th><th>미만</th><th>원문 함유량</th><th>15번 기재 규제</th><th>사용</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
}

function renderMcRegulations(res) {
  const reg = res.regulation;
  if (!reg.found) return '';
  const lawRows = reg.laws.map((l) => {
    const st = l.status === 'regulated' ? '<span class="tag-org">해당</span>'
      : l.status === 'not_applicable' ? '<span class="tag-gray">해당없음</span>'
      : '<span class="tag-gray">언급</span>';
    const items = l.positiveItems.map((it) => `<span class="mc-chip">${escHtml(it)}</span>`).join('');
    const neg = l.negativeItems.length ? `<div class="law-note">해당없음: ${escHtml(l.negativeItems.join(', '))}</div>` : '';
    return `<tr><th>${escHtml(l.law)}</th><td>${st}</td><td>${items || '-'}${neg}</td></tr>`;
  }).join('');
  const product = (res.productLevelRegs || []).map((g) => `<span class="mc-chip">${escHtml(mcLawShort(g.law))}·${escHtml(g.item)}</span>`).join('');
  return `<div class="mc-sub-title">15번 법적 규제현황</div>
    ${lawRows ? `<div class="tbl-wrap"><table class="reg mc-laws"><tbody>${lawRows}</tbody></table></div>` : '<div class="mc-note">법령명을 찾지 못했습니다.</div>'}
    ${product ? `<div class="mc-note">성분이 특정되지 않은 규제 기재: ${product}</div>` : ''}`;
}

function mcRawText(res) {
  return res.pages.map((p) => `===== ${p.pageNo}페이지 (${p.source === 'ocr' ? 'OCR' : '텍스트'}) =====\n` +
    p.lines.map((l) => l.text).join('\n')).join('\n\n');
}

/* ── 직접입력 시트로 보내기 ─────────────────────────────── */
function sendMsdsCheckToSheet(idx) {
  const res = msdsCheckResults[idx];
  if (!res) return;
  const rows = [];
  res.composition.rows.forEach((r, i) => {
    const use = document.getElementById(`mc-${idx}-${i}-use`);
    if (use && !use.checked) return;
    const cas = (document.getElementById(`mc-${idx}-${i}-cas`) || {}).value || '';
    if (!cas.trim()) return;
    const minRaw = (document.getElementById(`mc-${idx}-${i}-min`) || {}).value;
    const maxRaw = (document.getElementById(`mc-${idx}-${i}-max`) || {}).value;
    const lt = !!(document.getElementById(`mc-${idx}-${i}-lt`) || {}).checked;
    if (r.sharedContent && (maxRaw === '' || maxRaw == null)) { alert('후보 성분군 합계는 개별 함유량이 아닙니다. 선택한 행의 개별 함유량을 입력하세요.'); return; }
    rows.push({
      cas: cas.trim(),
      min: minRaw !== '' && minRaw != null ? parseFloat(minRaw) : null,
      max: maxRaw !== '' && maxRaw != null ? parseFloat(maxRaw) : null,
      isLt: lt,
    });
  });
  if (!rows.length) { alert('보낼 CAS 행이 없습니다.'); return; }

  const title = res.productName || res.fileName.replace(/\.[^.]+$/, '');

  // 비어 있는 첫 시트(제목·CAS 모두 없음)가 있으면 재사용
  let sid = null;
  const sheets = [...document.getElementById('msdsSheets').children];
  for (const sh of sheets) {
    const id = sh.id.replace('sheet-', '');
    const titleEl = sh.querySelector('.msds-sheet-head input');
    const casInputs = [...sh.querySelectorAll('input[id^="cas-"]')];
    if (!(titleEl && titleEl.value.trim()) && casInputs.every((c) => !c.value.trim())) {
      sid = Number(id);
      titleEl.value = title;
      break;
    }
  }
  if (sid == null) {
    addMsdsSheet(title);
    sid = sheetId;
  }
  const rowsDiv = document.getElementById('rows-' + sid);
  rowsDiv.innerHTML = '';
  rows.forEach((r) => addManualRow(sid, r.cas, r.min, r.max, r.isLt));

  const sheetEl = document.getElementById('sheet-' + sid);
  if (sheetEl) sheetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

window.addEventListener('load', initMsdsUpload);
