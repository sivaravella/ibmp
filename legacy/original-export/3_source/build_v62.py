src=open('IBMP_App_v6.0_BASELINE_LOCKED.html',encoding='utf-8').read()
mod=open('rtn_module.html',encoding='utf-8').read()
def rep(s,a,b,n=1):
    assert s.count(a)==n, (s.count(a), a[:80]); return s.replace(a,b)

# FIX 1 — malformed tag in purchase modal (left 2 <div>s unclosed → 7 modals trapped)
s=rep(src,"""    </div>
    <div       </div><!-- /pur-goods-section -->
      <div class="modal-footer">""","""      </div><!-- /pur-goods-section -->
    </div><!-- /modal-body -->
    <div class="modal-footer">""")

# FIX 2 — purchase bill added twice to table (remove the first, duplicate row)
s=rep(s,"""  const tr=document.createElement('tr');
  tr.innerHTML=`<td class="mono text-sm">${billNo}</td><td class="text-sm">${date}</td><td class="fw-600">${vObj.name}</td><td>${lines.map(l=>l.name+' ('+l.qty+')').join(', ')}</td><td class="num">₹${fmt(total)}</td><td><span class="pill pill-green">✓ Stock Updated</span></td>`;
  tbody.prepend(tr);
""","")
s=rep(s,"""`<td><span style="font-size:.72rem;color:#6B7280">Pay from Receipts/Payments tab</span></td>`;""",
        """`<td><span style="font-size:.72rem;color:#0EA472">✓ Stock updated</span><br><span style="font-size:.72rem;color:#6B7280">Pay from Receipts/Payments tab</span></td>`;""")
s=rep(s,"""<tbody id="purchases-table-body"><tr><td colspan="6" ""","""<tbody id="purchases-table-body"><tr><td colspan="7" """)

# FIX 3 — purchase GST: use selected rate; line values are taxable (excl. GST), GST added on top
s=rep(s,"""  const gstRate=0.18; const taxableAmt=Math.round(total/(1+gstRate)*100)/100; const gstInp=total-taxableAmt;
""","""  const gstPct=parseFloat((document.getElementById('pur-gst')||{}).value)||0;
  const taxableAmt=Math.round(total*100)/100; const gstInp=Math.round(taxableAmt*gstPct)/100;
  total=Math.round((taxableAmt+gstInp)*100)/100;
""")
s=rep(s,"""  const purObj={billNo, date, vendor:vObj.name, total, taxable:taxableAmt, gst:gstInp, status:'Unpaid', outstanding:total};""",
        """  const purObj={billNo, date, vendor:vObj.name, total, taxable:taxableAmt, gst:gstInp, gstPct, gstMode:'exclusive', status:'Unpaid', outstanding:total};""")

i=s.rfind('</body>')
open('IBMP_App_v6.2.html','w',encoding='utf-8').write(s[:i]+mod+'\n'+s[i:])
print('built')
