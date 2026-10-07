const { chromium } = require('playwright');
const SP='/tmp/claude-0/-home-claude/a25c658b-7edd-5af7-81f1-1caad7180fd6/scratchpad/';
(async()=>{
 const res={};
 for(const f of ['IBMP_App_v6.0_BASELINE_LOCKED.html','IBMP_App_v6.2.html']){
  const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1400,height:950}});
  const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('dialog',d=>d.dismiss());
  await p.goto('file://'+process.cwd()+'/'+f); await p.waitForTimeout(400);
  await p.evaluate(()=>{loadDemo();goTo('screen-app');});
  // FIX1: every modal visible when opened
  const vis=await p.evaluate(()=>[...document.querySelectorAll('.mo,.modal-overlay')].map(m=>{
     m.classList.add('open'); const r=m.getBoundingClientRect(); const ok=r.width>0&&r.height>0; m.classList.remove('open'); return m.id+':'+(ok?'OK':'HIDDEN');}));
  // purchase modal via real opener
  const pm=await p.evaluate(()=>{openPurchaseModal(); const r=document.getElementById('purchase-modal').getBoundingClientRect(); return r.width>0;});
  if(f.includes('6.2')) await p.screenshot({path:SP+'p_modal.png'});
  // FIX2+3: 12% bill, 10 x 500
  const pur=await p.evaluate(()=>{ showTab('purchases'); openPurchaseModal(); document.getElementById('pur-vendor').selectedIndex=1; document.getElementById('pur-gst').value='12';
     const tr=document.querySelector('#pur-items-body tr'); tr.querySelector('.pl-name').value='Piston Ring Set'; tr.querySelector('.pl-qty').value=10; tr.querySelector('.pl-rate').value=500; calcPur(); savePurchase();
     return {rows:document.querySelectorAll('#purchases-table-body tr').length, bill:PURCHASES_STORE[0], je:JOURNAL[JOURNAL.length-1].entries, stock:ITEMS[3].stock};});
  let ret=null;
  if(f.includes('6.2')){
    ret=await p.evaluate(()=>{ const bl=PURCHASES_STORE[0]; rtn_open('purchase',bl.billNo); document.getElementById('rtn-reason').selectedIndex=1; rtn_setLine(0,'q',4);
      const ok=rtn_submit(); return {ok, err:document.getElementById('rtn-err').textContent, je:JOURNAL[JOURNAL.length-1].entries, out:PURCHASES_STORE[0].outstanding, stock:ITEMS[3].stock}; });
    await p.evaluate(()=>showTab('purchases')); await p.screenshot({path:SP+'p_tab.png'});
    // employee modal really opens via its own button function
    ret.emp=await p.evaluate(()=>{ closeAllModals(); showTab('employees'); const fn=['openQuickAdd','openEmpModal'].find(n=>typeof window[n]==='function'); try{ window[fn]('employee'); }catch(e){return fn+' threw '+e.message;} const m=[...document.querySelectorAll('.mo.open,.modal-overlay.open')].map(x=>x.id+':'+(x.getBoundingClientRect().width>0)); return fn+' → '+m.join(','); });
    await p.screenshot({path:SP+'p_emp.png'});
  }
  res[f]={vis:vis.filter(v=>v.endsWith('HIDDEN')), purchaseModal:pm, pur, ret, errs};
  await b.close();
 }
 console.log(JSON.stringify(res,null,1));
})();
