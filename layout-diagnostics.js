/* Layout-only diagnostics. No field values, DOM text, URLs, storage or account data. */
(() => {
  'use strict';
  const history = [];
  const errors = [];
  let beforeSettings = null;
  let timer;
  const round = value => Math.round(value * 100) / 100;
  const rect = element => {
    const r = element.getBoundingClientRect();
    return Object.fromEntries(['x','y','width','height','top','right','bottom','left'].map(key => [key,round(r[key])]));
  };
  const identifier = element => ({tag:element.tagName.toLowerCase(),
    id:element.id && !/\d{8}|[a-f0-9]{20}/i.test(element.id) ? element.id.slice(0,100) : '',
    classes:[...element.classList].filter(name => !/\d{8}|[a-f0-9]{20}/i.test(name)).slice(0,12),
    type:element instanceof HTMLInputElement ? element.type : undefined});
  const mediaQueries = ['(hover:none)','(hover:hover)','(pointer:coarse)','(pointer:fine)','(any-pointer:coarse)',
    '(any-hover:hover)','(prefers-reduced-motion:reduce)','(prefers-color-scheme:dark)',
    '(orientation:portrait)','(display-mode:standalone)',... [480,640,700,760,900,1100,1200,1600].map(n => `(max-width:${n}px)`)];
  function environment() {
    const vv = window.visualViewport;
    return {
      timestamp:new Date().toISOString(), viewport:{innerWidth,innerHeight,outerWidth,outerHeight,
        devicePixelRatio,scrollX,scrollY,documentWidth:document.documentElement.clientWidth,
        documentHeight:document.documentElement.clientHeight,
        scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,
        visual:vv ? Object.fromEntries(['width','height','scale','offsetLeft','offsetTop','pageLeft','pageTop'].map(key => [key,round(vv[key])])) : null},
      screen:{width:screen.width,height:screen.height,availWidth:screen.availWidth,availHeight:screen.availHeight,
        colorDepth:screen.colorDepth,orientation:screen.orientation?.type || null,angle:screen.orientation?.angle ?? null},
      activeElement:document.activeElement ? identifier(document.activeElement) : null,
      bodyClasses:[...document.body.classList],visibility:document.visibilityState,
      fullscreen:!!document.fullscreenElement,
      media:Object.fromEntries(mediaQueries.map(query => [query,matchMedia(query).matches]))
    };
  }
  const properties = ['display','position','boxSizing','width','height','minWidth','maxWidth','minHeight','maxHeight',
    'overflowX','overflowY','fontSize','lineHeight','fontFamily','padding','margin','borderWidth','borderRadius',
    'transform','transformOrigin','zoom','textSizeAdjust','webkitTextSizeAdjust','flex','flexDirection','flexWrap',
    'gridTemplateColumns','gap','aspectRatio','contain','zIndex'];
  function measure(element, index) {
    const style = getComputedStyle(element);
    const bounds = rect(element);
    const input = element.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]),textarea,select,[contenteditable=true]');
    return {index,...identifier(element),bounds,
      client:{width:element.clientWidth,height:element.clientHeight},
      scroll:{width:element.scrollWidth,height:element.scrollHeight,left:element.scrollLeft,top:element.scrollTop},
      styles:Object.fromEntries(properties.map(key => [key,style[key] || ''])),
      inputZoomRisk:input && parseFloat(style.fontSize)<16,
      horizontalOverflow:element.scrollWidth>element.clientWidth+1,
      verticalOverflow:element.scrollHeight>element.clientHeight+1,
      outsideViewport:bounds.right>innerWidth+1 || bounds.left < -1,
      focused:element===document.activeElement};
  }
  function snapshot(reason) {
    const all = [...document.querySelectorAll('body *')];
    const visible = all.filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
    const important = element => element.matches('input,textarea,select,[contenteditable=true],.settings-panel,.modal-box,.modal-overlay,.fullscreen-player-overlay,.fullscreen-player-stage,.fullscreen-player-camera,.fullscreen-player-turntable,.fullscreen-player-room,.room-window,header,main');
    const selected = [...new Set([...visible.filter(important),...visible.filter(element => element.scrollWidth>element.clientWidth+1 || element.scrollHeight>element.clientHeight+1)])].slice(0,1000);
    return {reason,...environment(),visibleElementCount:visible.length,measuredElementCount:selected.length,
      truncated:selected.length===1000,elements:selected.map(measure)};
  }
  function record(kind) {
    history.push({kind,...environment()});
    if (history.length>80) history.shift();
  }
  function schedule(kind) {
    clearTimeout(timer);
    timer=setTimeout(() => record(kind),200);
  }
  window.addEventListener('resize',() => schedule('resize'));
  window.addEventListener('orientationchange',() => schedule('orientationchange'));
  window.visualViewport?.addEventListener('resize',() => schedule('visual-viewport-resize'));
  window.visualViewport?.addEventListener('scroll',() => schedule('visual-viewport-scroll'));
  document.addEventListener('focusin',() => record('focus'));
  document.addEventListener('focusout',() => schedule('blur'));
  document.addEventListener('pointerdown',event => {
    if (event.target.closest?.('#settingsBtn') && !document.getElementById('settingsPanel')?.classList.contains('open')) {
      beforeSettings=snapshot('before-opening-settings');
    }
  },true);
  // Keep locations and error categories only: messages/stacks can contain private data.
  window.addEventListener('error',event => {
    errors.push({at:new Date().toISOString(),kind:event.error?.name || 'resource-or-script-error',line:event.lineno || null,column:event.colno || null});
    if(errors.length>40)errors.shift();
  },true);
  window.addEventListener('unhandledrejection',() => {
    errors.push({at:new Date().toISOString(),kind:'unhandled-promise-rejection'});
    if(errors.length>40)errors.shift();
  });
  document.getElementById('exportLayoutDiagnosticsBtn')?.addEventListener('click',() => {
    const status=document.getElementById('layoutDiagnosticsStatus');
    try {
      const report={schema:'vinyl-layout-diagnostics',version:1,
        browser:{userAgent:navigator.userAgent,platform:navigator.platform,languages:navigator.languages,
          maxTouchPoints:navigator.maxTouchPoints,cookieEnabled:navigator.cookieEnabled,online:navigator.onLine},
        capabilities:{visualViewport:!!window.visualViewport,cssGrid:CSS.supports('display','grid'),
          dynamicViewport:CSS.supports('height','100dvh'),colorMix:CSS.supports('color','color-mix(in srgb,red,blue)')},
        document:{compatMode:document.compatMode,readyState:document.readyState,
          viewportMeta:document.querySelector('meta[name=viewport]')?.content || '',fontsStatus:document.fonts?.status || null},
        current:snapshot('export'),beforeSettings,history:[...history],errors:[...errors],
        notes:['No field values, page text, account data, storage contents, cookies, URLs or tokens are collected.',
          'Input zoom risks are font-size hints, not proof of browser zoom.','Measurements use CSS pixels unless stated otherwise.']};
      const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'});
      const url=URL.createObjectURL(blob);
      const link=document.createElement('a');link.href=url;
      link.download=`vinyl-layout-diagnose-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
      document.body.append(link);link.click();link.remove();
      setTimeout(() => URL.revokeObjectURL(url),30000);
      status.textContent='Diagnose exportiert. Die JSON-Datei kannst du hier zur Analyse anhängen.';
    } catch { status.textContent='Diagnose konnte nicht exportiert werden. Bitte erneut versuchen.'; }
  });
  record('diagnostics-ready');
})();
