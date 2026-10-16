// plugin/spin-bounce/integrations/panel.js — 插件自己的设置面板。
//
// 为什么不去改游戏的设置弹窗：那是 Preact 渲染的（`public/js/ui/settings.js` 的 `Modal`），
// 往里注入 DOM 会和框架的 diff 打架（重渲染时被抹掉）。独立悬浮面板既不动随包文件，
// 也不会与任何渲染框架冲突 —— 而且卸载时删得干净。
//
// 样式全部加 `sbp-` 前缀并使用内联样式表，避免与游戏 CSS 撞名。

const PANEL_ID = 'sbp-panel';
const BUTTON_ID = 'sbp-button';
const STYLE_ID = 'sbp-style';

const CSS = `
#${BUTTON_ID}{position:fixed;right:.42rem;bottom:.42rem;z-index:9998;height:.42rem;min-width:.42rem;
  padding:0 .14rem;border-radius:99px;border:1px solid rgba(78,216,175,.55);background:rgba(16,20,18,.88);
  color:#4ed8af;font:600 12px/1 "Noto Sans SC",system-ui,sans-serif;cursor:pointer;
  display:flex;align-items:center;gap:.06rem;backdrop-filter:blur(4px);
  box-shadow:0 .04rem .16rem rgba(0,0,0,.45)}
#${BUTTON_ID}::before{content:"弹";font-size:14px}
#${BUTTON_ID} i{font-style:normal;opacity:.75;font-size:10px}
#${BUTTON_ID}:hover{border-color:#4ed8af;background:rgba(16,20,18,.95)}
#${PANEL_ID}{position:fixed;right:.5rem;bottom:1.15rem;z-index:9999;width:3.4rem;padding:.22rem .26rem;
  background:rgba(12,16,14,.96);border:1px solid #2f3a35;border-radius:.12rem;color:#c3cbc7;
  font:12px/1.5 "Noto Sans SC",system-ui,sans-serif;backdrop-filter:blur(6px);
  box-shadow:0 .08rem .3rem rgba(0,0,0,.5)}
#${PANEL_ID}[hidden]{display:none}
#${PANEL_ID} h3{margin:0 0 .14rem;font-size:13px;color:#f2f2f2;letter-spacing:.04em;font-weight:600}
#${PANEL_ID} .sbp-row{display:flex;align-items:center;justify-content:space-between;gap:.12rem;margin:.1rem 0}
#${PANEL_ID} label{flex:1;min-width:0}
#${PANEL_ID} small{display:block;color:#8a948f;font-size:10px;line-height:1.35}
#${PANEL_ID} input[type=range]{width:1.5rem;flex:none}
#${PANEL_ID} output{flex:none;width:.62rem;text-align:right;font-variant-numeric:tabular-nums;color:#4ed8af}
#${PANEL_ID} .sbp-sw{flex:none;width:.42rem;height:.2rem;border-radius:99px;border:1px solid #3e4b45;
  background:#1e2421;position:relative;cursor:pointer;padding:0;transition:background .18s}
#${PANEL_ID} .sbp-sw::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;
  background:#5d6863;transition:transform .18s,background .18s}
#${PANEL_ID} .sbp-sw[aria-checked=true]{background:rgba(78,216,175,.25);border-color:#4ed8af}
#${PANEL_ID} .sbp-sw[aria-checked=true]::after{transform:translateX(16px);background:#4ed8af}
#${PANEL_ID} .sbp-sub{margin:.12rem 0 0;padding:.1rem 0 0;border-top:1px solid #2f3a35}
#${PANEL_ID} .sbp-sub[hidden]{display:none}
#${PANEL_ID} .sbp-note{margin:.1rem 0 0;color:#8a948f;font-size:10px;line-height:1.4}
#${PANEL_ID} select{background:#1e2421;color:#c3cbc7;border:1px solid #3e4b45;border-radius:.06rem;
  font:inherit;padding:2px 4px;flex:none}
`;

const ensureStyle = (doc) => {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  doc.head?.appendChild(s);
};

const el = (doc, tag, props = {}) => Object.assign(doc.createElement(tag), props);

function row(doc, labelText, hintText) {
  const r = el(doc, 'div', { className: 'sbp-row' });
  const l = el(doc, 'label', { textContent: labelText });
  if (hintText) l.appendChild(el(doc, 'small', { textContent: hintText }));
  r.appendChild(l);
  return r;
}

function toggle(doc, checked, onToggle) {
  const b = el(doc, 'button', { className: 'sbp-sw', type: 'button' });
  b.setAttribute('role', 'switch');
  const sync = (v) => {
    b.setAttribute('aria-checked', String(!!v));
    b.setAttribute('aria-label', v ? '已开启' : '已关闭');
  };
  sync(checked);
  b.addEventListener('click', () => { const v = b.getAttribute('aria-checked') !== 'true'; sync(v); onToggle(v); });
  return { node: b, sync };
}

function slider(doc, { min, max, step, value, format }, onInput) {
  const wrap = el(doc, 'div', { className: 'sbp-row' });
  const input = el(doc, 'input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  const out = el(doc, 'output', { textContent: format(value) });
  input.addEventListener('input', () => { const v = Number(input.value); out.textContent = format(v); onInput(v); });
  wrap.appendChild(input);
  wrap.appendChild(out);
  return { node: wrap, input, out };
}

/**
 * 挂载插件设置面板。
 *
 * @param {object} o
 * @param {Document} o.doc
 * @param {object} o.settings 当前设置（会被读取；改动通过 onChange 回传）
 * @param {object} [o.music] 音乐控制器（用于开关时立即播放/暂停）
 * @param {(next:object)=>void} o.onChange
 */
export function attachSettingsPanel(o) {
  const doc = o.doc ?? document;
  const settings = o.settings;
  if (!doc?.body) return null;
  ensureStyle(doc);

  // --- 入口按钮
  let button = doc.getElementById(BUTTON_ID);
  if (!button) {
    button = el(doc, 'button', { id: BUTTON_ID, type: 'button', title: '弹跳自转设置（点击展开）' });
    button.appendChild(el(doc, 'i', { textContent: '设置' }));
    doc.body.appendChild(button);
  }

  // --- 面板
  let panel = doc.getElementById(PANEL_ID);
  if (panel) panel.remove();          // 重建，避免旧闭包引用过期设置
  panel = el(doc, 'div', { id: PANEL_ID });
  panel.hidden = true;

  panel.appendChild(el(doc, 'h3', { textContent: '弹跳自转' }));

  // 状态行：让玩家一眼看出插件有没有在工作（而不是靠猜）
  const statusLine = el(doc, 'p', { className: 'sbp-note', textContent: '状态：读取中…' });
  const refreshStatus = () => {
    if (typeof o.status !== 'function') { statusLine.textContent = ''; return; }
    try {
      const st = o.status() || {};
      statusLine.textContent = st.degraded
        ? '状态：已自动关闭（每帧耗时过高）'
        : !st.hooked ? '状态：等待进入对局（渲染器未加载）'
          : !st.layer ? '状态：已挂钩，等待单位'
            : `状态：运行中 · ${st.units} 个单位`;
    } catch { statusLine.textContent = ''; }
  };
  refreshStatus();
  const statusTimer = setInterval(refreshStatus, 1000);
  panel.appendChild(statusLine);

  const eff = toggle(doc, settings.effect.enabled, (v) => {
    settings.effect.enabled = v;
    music?.setEnabled?.(v && settings.music.enabled);
    sub.hidden = !v;
    musicRow.hidden = !v;
    o.onChange?.(settings);
  });
  const effRow = row(doc, '弹跳自转', '单位在格子里压扁回弹并自转');
  effRow.appendChild(eff.node);
  panel.appendChild(effRow);

  // 音乐开关：**只在特效开启时展示**（用户要求）
  const mus = toggle(doc, settings.music.enabled, async (v) => {
    settings.music.enabled = v;
    music?.setEnabled?.(v);
    if (v) {
      // 必须在用户手势里调用 —— 这个点击就是手势
      const ok = await music?.play?.();
      if (ok === false && music?.state?.blocked) {
        note.textContent = '浏览器拦截了自动播放，请再点一次音乐开关。';
      } else {
        note.textContent = '';
      }
    } else {
      music?.pause?.();
      note.textContent = '';
    }
    o.onChange?.(settings);
  });
  const musicRow = row(doc, '自定义音乐', '独立于游戏 BGM；需自备音频文件');
  musicRow.appendChild(mus.node);
  panel.appendChild(musicRow);

  // --- 细节（折叠在特效开关之下）
  const sub = el(doc, 'div', { className: 'sbp-sub' });
  sub.hidden = !settings.effect.enabled;

  const strength = slider(doc, {
    min: 0.3, max: 1.8, step: 0.05, value: settings.effect.strength,
    format: (v) => `${v.toFixed(2)}×`,
  }, (v) => { settings.effect.strength = v; o.onChange?.(settings); });
  const strengthRow = row(doc, 'Q弹强度', '越大压得越扁');
  strengthRow.appendChild(strength.node);
  sub.appendChild(strengthRow);

  const period = slider(doc, {
    min: 0.8, max: 12, step: 0.1, value: settings.effect.spinPeriod,
    format: (v) => `${v.toFixed(1)}s`,
  }, (v) => { settings.effect.spinPeriod = v; o.onChange?.(settings); });
  const periodRow = row(doc, '自转周期', '转一圈的秒数');
  periodRow.appendChild(period.node);
  sub.appendChild(periodRow);

  const smooth = slider(doc, {
    min: 8, max: 90, step: 1, value: settings.effect.spinWritesPerSec,
    format: (v) => `${v}/s`,
  }, (v) => { settings.effect.spinWritesPerSec = v; o.onChange?.(settings); });
  const smoothRow = row(doc, '自转顺滑度', '每秒刷新次数；调高更顺、更耗性能');
  smoothRow.appendChild(smooth.node);
  sub.appendChild(smoothRow);

  const continuous = toggle(doc, settings.effect.spinSmooth, (v) => {
    settings.effect.spinSmooth = v; o.onChange?.(settings);
  });
  const contRow = row(doc, '挤压用连续波形', '关闭则改成"踢一脚+回弹"（更弹但更顿）');
  contRow.appendChild(continuous.node);
  sub.appendChild(contRow);

  const syncB = toggle(doc, settings.effect.syncBounce, (v) => {
    settings.effect.syncBounce = v; o.onChange?.(settings);
  });
  const syncBRow = row(doc, '整齐弹跳', '全场单位同步起伏；关闭则各自计时、错落一些');
  syncBRow.appendChild(syncB.node);
  sub.appendChild(syncBRow);

  const syncS = toggle(doc, settings.effect.syncSpin, (v) => {
    settings.effect.syncSpin = v; o.onChange?.(settings);
  });
  const syncSRow = row(doc, '整齐自转', '全场单位角度一致；关闭则各自起算，方向感更随机');
  syncSRow.appendChild(syncS.node);
  sub.appendChild(syncSRow);

  const axisRow = row(doc, '自转方式', '竖轴=梗图效果；平面=躺倒打转');
  const axis = el(doc, 'select');
  for (const [v, label] of [['vertical', '竖轴'], ['screen', '平面']]) {
    const opt = el(doc, 'option', { value: v, textContent: label });
    if (settings.effect.spinAxis === v) opt.selected = true;
    axis.appendChild(opt);
  }
  axis.addEventListener('change', () => { settings.effect.spinAxis = axis.value; o.onChange?.(settings); });
  axisRow.appendChild(axis);
  sub.appendChild(axisRow);

  const dead = toggle(doc, settings.effect.deadBounce, (v) => { settings.effect.deadBounce = v; o.onChange?.(settings); });
  const deadRow = row(doc, '死亡后继续弹跳', '默认关闭；自转不受影响，始终继续');
  deadRow.appendChild(dead.node);
  sub.appendChild(deadRow);

  panel.appendChild(sub);

  const note = el(doc, 'p', { className: 'sbp-note', textContent: '' });
  panel.appendChild(note);

  doc.body.appendChild(panel);

  const open = (v) => { panel.hidden = !v; button.setAttribute('aria-expanded', String(v)); };
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', (e) => { e.stopPropagation(); open(panel.hidden); });

  // 点击面板外或按 Esc 收起
  const onDocClick = (e) => { if (!panel.hidden && !panel.contains(e.target) && e.target !== button) open(false); };
  const onKey = (e) => { if (e.key === 'Escape' && !panel.hidden) open(false); };
  doc.addEventListener('pointerdown', onDocClick, true);
  doc.addEventListener('keydown', onKey, true);

  return {
    open,
    destroy() {
      clearInterval(statusTimer);
      doc.removeEventListener('pointerdown', onDocClick, true);
      doc.removeEventListener('keydown', onKey, true);
      panel.remove();
      button.remove();
      doc.getElementById(STYLE_ID)?.remove();
    },
  };
}
