import json,re,collections,math,sys
j=json.load(open(sys.argv[1]))
objs=j['OBJECTS']
lay={o['handle'][-1]:o['name'] for o in objs if o.get('object')=='LAYER'}
BH={o['handle'][-1]:o for o in objs if o.get('object')=='BLOCK_HEADER'}
byowner=collections.defaultdict(list)
ms=None
for o in objs:
    if o.get('object')=='BLOCK_HEADER' and o['name']=='*Model_Space': ms=o['handle'][-1]
for o in objs:
    if 'entity' in o and o['entity'] not in('BLOCK','ENDBLK','ATTDEF'):
        ow=o.get('ownerhandle'); 
        # libredwg: ownerhandle is relative; absolute is last
        key=(ow[-1] if (ow and ow[-1] in BH) else ms)
        byowner[key].append(o)
def L(e):
    x=e.get('layer'); return lay.get(x[-1]) if isinstance(x,list) else None
def clean(s): return re.sub(r'\\[A-Za-z][^;\\]*;|\\P|[{}]',' ',s or '').strip()
out=[]  # (kind, layer, data)
def xf(p,T):
    (ox,oy,sx,sy,r,bx,by)=T
    x=(p[0]-bx)*sx; y=(p[1]-by)*sy
    c,s=math.cos(r),math.sin(r)
    return (ox+x*c-y*s, oy+x*s+y*c)
def walk(key,T,depth,inl):
    if depth>6: return
    for e in byowner.get(key,[]):
        t=e['entity']; l=L(e)
        if l=='0' and inl: l=inl
        if t=='LWPOLYLINE' and e.get('points'):
            P=[xf(p,T) for p in e['points']]
            out.append(('pl',l,P,bool(e.get('flag',0)&512 or e.get('flag',0)&1)))
        elif t=='LINE':
            out.append(('pl',l,[xf(e['start'],T),xf(e['end'],T)],False))
        elif t in('TEXT','MTEXT'):
            p=e.get('ins_pt') or [0,0]
            out.append(('tx',l,xf(p,T),clean(e.get('text_value') or e.get('text'))))
        elif t=='HATCH':
            for pth in e.get('paths') or []:
                pp=pth.get('polyline_paths')
                if pp: out.append(('ht',l,[xf(q['point'],T) for q in pp],(e.get('color') or {}).get('index'),(e.get('color') or {}).get('rgb')))
        elif t=='CIRCLE':
            pass
        elif t=='INSERT':
            bh=e.get('block_header'); 
            if not bh: continue
            b=BH.get(bh[-1]); 
            if not b: continue
            sc=e.get('scale',[1,1,1]); ip=e.get('ins_pt',[0,0,0]); bp=b.get('base_pt',[0,0,0])
            p0=xf(ip,T)
            T2=(p0[0],p0[1],sc[0]*T[2],sc[1]*T[3],e.get('rotation',0)+T[4],bp[0],bp[1])
            walk(bh[-1],T2,depth+1,l)
walk(ms,(0,0,1,1,0,0,0),0,None)
json.dump(out,open(sys.argv[2],'w'))
print(len(out), collections.Counter((k,l) for k,l,*_ in out).most_common(40))
