const { chromium } = require('playwright');
(async()=>{
 const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1400,height:950}});
 const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error'&&!/net::|Failed to load/.test(m.text()))errs.push(m.text())});
 p.on('dialog',d=>d.dismiss());
 await p.goto('file://'+process.cwd()+'/IBMP_App_v6.2.html'); await p.waitForTimeout(500);
 const log=async(l,f,a)=>console.log(l, JSON.stringify(await p.evaluate(f,a)));
 await p.evaluate(()=>{loadDemo();goTo('screen-app');showTab('invoice-new');});
 // build invoice: 10 x Liner 80mm @1200, 4 x Piston @850
 await p.evaluate(()=>{
   document.getElementById('line-items-body').innerHTML=''; lineCount=0; addLine(); addLine();
   const rows=document.querySelectorAll('#line-items-body tr');
   const set=(tr,n,q)=>{tr.querySelector('.li-name').value=n; autofillItem(tr.querySelector('.li-name')); tr.querySelector('.li-qty').value=q;};
   set(rows[0],'Cylinder Liner — 80mm',10); set(rows[1],'Piston Ring Set',4);
   const sel=document.getElementById('inv-party'); sel.selectedIndex=1; recalcAll(); confirmSaveInvoice();
 });
 await log('new invoice', ()=>({inv:INVOICES_STORE[0], stock:ITEMS.map(i=>i.stock)}));
 // sales return partial: 3 liners
 await p.evaluate(()=>{ rtn_open('sales'); const inv=INVOICES_STORE[0];
   document.getElementById('rtn-party').value=inv.party; rtn_onParty(); document.getElementById('rtn-doc').value=inv.invNum; rtn_onDoc();
   document.getElementById('rtn-reason').selectedIndex=1; rtn_setLine(0,'q',3); });
 await p.screenshot({path:'/tmp/claude-0/-home-claude/a25c658b-7edd-5af7-81f1-1caad7180fd6/scratchpad/s1.png'});
 await log('submit1', ()=>{ const r=rtn_submit(); return {r, err:document.getElementById('rtn-err').textContent}; });
 await log('after partial', ()=>({inv:{o:INVOICES_STORE[0].outstanding,s:INVOICES_STORE[0].status,rv:INVOICES_STORE[0]._rtnValue,q:INVOICES_STORE[0]._rtnQty}, stock:ITEMS.map(i=>i.stock), j:JOURNAL[JOURNAL.length-1], cn:CREDIT_NOTES.length}));
 // over-return check
 await log('over-return', ()=>{ rtn_open('sales'); const inv=INVOICES_STORE[0];
   document.getElementById('rtn-party').value=inv.party; rtn_onParty(); document.getElementById('rtn-doc').value=inv.invNum; rtn_onDoc();
   document.getElementById('rtn-reason').selectedIndex=1; rtn_setLine(0,'q',8); rtn_submit(); return document.getElementById('rtn-err').textContent; });
 // full remaining
 await log('full rest', ()=>{ rtn_fill(true); rtn_submit(); const i=INVOICES_STORE[0]; return {o:i.outstanding,s:i.status,rv:i._rtnValue,t:i.total,stock:ITEMS.map(x=>x.stock), pill:document.getElementById('st-'+i.invNum).textContent, opt:(rtn_open('sales'),document.getElementById('rtn-party').value=i.party,rtn_onParty(),[...document.getElementById('rtn-doc').options].map(o=>o.text+(o.disabled?' [disabled]':'')))}; });
 await p.evaluate(()=>rtn_close());
 // legacy paid invoice INV-2025-047 — full value reversal => excess refund
 await log('legacy', ()=>{ rtn_open('sales','INV-2025-047'); document.getElementById('rtn-reason').selectedIndex=5; rtn_fill(true); const eff=document.getElementById('rtn-effects').innerText; rtn_submit(); const i=INVOICES_STORE.find(x=>x.invNum==='INV-2025-047'); return {eff,o:i.outstanding,s:i.status,n:RTN.notes[0].total,ex:RTN.notes[0].excess}; });
 // legacy manual partial INV-2025-048
 await log('legacy manual', ()=>{ rtn_open('sales','INV-2025-048'); document.getElementById('rtn-reason').selectedIndex=1; rtn_setManualItem(0,'Cylinder Liner — 90mm'); rtn_setLine(0,'q',5); rtn_submit(); const i=INVOICES_STORE.find(x=>x.invNum==='INV-2025-048'); return {o:i.outstanding,s:i.status,note:RTN.notes[0].total,stock90:ITEMS[1].stock}; });
 // purchase
 await p.evaluate(()=>{ showTab('purchases'); openPurchaseModal(); const pv=document.getElementById('pur-vendor'); pv.selectedIndex=1;
   const tr=document.querySelector('#pur-items-body tr'); tr.querySelector('.pl-name').value='Piston Ring Set'; tr.querySelector('.pl-qty').value=100; tr.querySelector('.pl-rate').value=708; savePurchase(); });
 await log('purchase', ()=>({p:PURCHASES_STORE[0], stock:ITEMS[3].stock}));
 await p.evaluate(()=>{ rtn_open('purchase'); const b=PURCHASES_STORE[0]; document.getElementById('rtn-party').value=b.vendor; rtn_onParty(); document.getElementById('rtn-doc').value=b.billNo; rtn_onDoc(); document.getElementById('rtn-reason').selectedIndex=1; rtn_setLine(0,'q',20);});
 await p.screenshot({path:'/tmp/claude-0/-home-claude/a25c658b-7edd-5af7-81f1-1caad7180fd6/scratchpad/s2.png'});
 await log('pur return', ()=>{ rtn_submit(); const b=PURCHASES_STORE[0]; return {o:b.outstanding,s:b.status,stock:ITEMS[3].stock,j:JOURNAL[JOURNAL.length-1].entries}; });
 await p.evaluate(()=>showTab('purchases')); await p.screenshot({path:'/tmp/claude-0/-home-claude/a25c658b-7edd-5af7-81f1-1caad7180fd6/scratchpad/s3.png',fullPage:true});
 await p.evaluate(()=>showTab('invoices')); await p.screenshot({path:'/tmp/claude-0/-home-claude/a25c658b-7edd-5af7-81f1-1caad7180fd6/scratchpad/s4.png'});
 await log('ledgers', ()=>{ showTab('ledgers'); return document.getElementById('rtn-ledger-bal').innerText.slice(-400); });
 await p.evaluate(()=>{ showTab('gst'); }); await p.screenshot({path:'/tmp/claude-0/-home-claude/a25c658b-7edd-5af7-81f1-1caad7180fd6/scratchpad/s5.png'});
 await p.evaluate(()=>{ rtn_view(RTN.notes[RTN.notes.length-1].refNum); }); await p.screenshot({path:'/tmp/claude-0/-home-claude/a25c658b-7edd-5af7-81f1-1caad7180fd6/scratchpad/s6.png'});
 await p.evaluate(()=>{ closeModal('note-share-modal'); showTab('payments'); });
 console.log('ERRORS', errs); await b.close();
})();
