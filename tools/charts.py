import os, re, json, sys
from lxml import etree
root=sys.argv[1]
ns={'c':'http://schemas.openxmlformats.org/drawingml/2006/chart','a':'http://schemas.openxmlformats.org/drawingml/2006/main',
 'r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships','xdr':'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
 'm':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','rel':'http://schemas.openxmlformats.org/package/2006/relationships'}
def rels(p):
    d=os.path.dirname(p); f=os.path.join(d,'_rels',os.path.basename(p)+'.rels')
    if not os.path.exists(f): return {}
    t=etree.parse(f); return {e.get('Id'):os.path.normpath(os.path.join(d,e.get('Target'))) for e in t.getroot()}
wb=etree.parse(f'{root}/xl/workbook.xml'); wr=rels(f'{root}/xl/workbook.xml')
out=[]
for s in wb.findall('.//m:sheet',ns):
    name=s.get('name'); sp=wr[s.get('{%s}id'%ns['r'])]
    sr=rels(sp)
    for rid,dp in sr.items():
        if 'drawing' not in dp: continue
        dt=etree.parse(dp); dr=rels(dp)
        for anc in dt.getroot():
            fr=anc.find('.//xdr:from',ns)
            row=int(fr.find('xdr:row',ns).text) if fr is not None else -1
            col=int(fr.find('xdr:col',ns).text) if fr is not None else -1
            for ch in anc.findall('.//c:chart',ns):
                cp=dr[ch.get('{%s}id'%ns['r'])]
                ct=etree.parse(cp).getroot()
                title=''.join(ct.xpath('./c:chart/c:title//a:t/text()',namespaces=ns))
                plot=ct.find('.//c:plotArea',ns)
                types=[]; series=[]
                for g in plot:
                    tag=etree.QName(g).localname
                    if not tag.endswith('Chart'): continue
                    extra={}
                    bd=g.find('c:barDir',ns); gr=g.find('c:grouping',ns)
                    for ser in g.findall('c:ser',ns):
                        nm=''.join(ser.xpath('./c:tx//c:v/text()|./c:tx//a:t/text()',namespaces=ns))
                        cats=ser.xpath('./c:cat//c:pt/c:v/text()',namespaces=ns)
                        # multi-level
                        lvls=ser.xpath('./c:cat//c:lvl',namespaces=ns)
                        if lvls: cats=[ [p.findtext('c:v',namespaces=ns) for p in l.findall('c:pt',ns)] for l in lvls]
                        def pts(xp):
                            res={}
                            for p in ser.xpath(xp,namespaces=ns):
                                res[int(p.get('idx'))]=p.findtext('c:v',namespaces=ns)
                            return res
                        v=pts('./c:val//c:pt') or pts('./c:yVal//c:pt')
                        if not lvls:
                            cd={int(p.get('idx')):p.findtext('c:v',namespaces=ns) for p in ser.xpath('./c:cat//c:pt|./c:xVal//c:pt',namespaces=ns)}
                            n=max(list(cd.keys())+list(v.keys())+[-1])+1
                            cats=[cd.get(i) for i in range(n)]
                        else: n=max(list(v.keys())+[-1])+1
                        vals=[float(v[i]) if i in v and v[i] not in (None,'') else None for i in range(n)]
                        ref=''.join(ser.xpath('./c:val//c:f/text()|./c:yVal//c:f/text()',namespaces=ns))
                        series.append({'name':nm,'type':tag,'barDir':bd.get('val') if bd is not None else None,'grouping':gr.get('val') if gr is not None else None,'cats':cats,'vals':vals,'ref':ref})
                    types.append(tag)
                pivot=ct.find('.//c:pivotSource',ns) is not None
                out.append({'sheet':name,'row':row,'col':col,'chart':os.path.basename(cp),'title':title,'types':types,'pivot':pivot,'series':series})
json.dump(out,open(sys.argv[2],'w'),indent=1)
for o in out: print(o['sheet'],o['row'],o['col'],o['chart'],o['pivot'],o['types'],'|',o['title'][:80],'| nser',len(o['series']), 'npts', len(o['series'][0]['vals']) if o['series'] else 0)
