import json,numpy as np,re
from shapely.geometry import Polygon,LineString,Point,MultiPolygon
from shapely.ops import unary_union,polygonize
lv=json.load(open('lv_flat.json')); zp=json.load(open('zp_flat.json')); R=json.load(open('reg.json'))
c,s=np.cos(R['th']),np.sin(R['th']); cB=np.array(R['cB'])
def inv(P):  # zoning -> UTM
    P=(np.array(P)-[R['dx'],R['dy']])/R['sc']
    return np.c_[c*P[:,0]+s*P[:,1], -s*P[:,0]+c*P[:,1]]+cB
# parcel
lines=[LineString(o[2]) for o in lv if o[1]=='BD' and o[0]=='pl' and len(o[2])>1]
U=unary_union(lines).buffer(0.6)
polys=[Polygon(r) for g in (U.geoms if hasattr(U,'geoms') else [U]) for r in g.interiors]
polys=sorted(polys,key=lambda p:-p.area)
print('parcel pieces ac',[round(p.area/4046.86,2) for p in polys[:8]])
parcel=unary_union([p for p in polys if p.area>500])
print('parcel ac',parcel.area/4046.86)
# zone hatches
H=[o for o in zp if o[0]=='ht' and o[1] in ('PLOT DIV','Layer1') and len(o[2])>2]
labels=[(o[3],inv([o[2]])[0]) for o in zp if o[0]=='tx' and o[1]=='north' and 24000<o[2][0]<26500]
names=[(t,p) for t,p in labels if not t.startswith('AREA') and 'ROAD' not in t and t not in('N','S','E','W','MAIN GATE') and not t.startswith('TO ') and 'JUNCTION' not in t]
areas=[(t,p) for t,p in labels if t.startswith('AREA')]
hp=[]
for o in H:
    try:
        g=Polygon(inv(o[2])).buffer(0)
        if g.area>200: hp.append((o[3],g))
    except Exception: pass
print(len(hp),'hatch polys')
zones={}
asg={}
for i,(ci,g) in enumerate(hp):
    rp=g.representative_point()
    same=[(t,p) for t,p in names]
    t=min(same,key=lambda n: g.distance(Point(n[1]))*1000+rp.distance(Point(n[1])))[0]
    asg.setdefault(t,[]).append(g)
for t,p in names:
    al=min(areas,key=lambda a:np.hypot(*(np.array(a[1])-p)))[0]
    zones[t]={'label_area':al,'geom':unary_union(asg.get(t,[]))}
for _ in []:
    pt=Point(p)
    # nearest area label
    al=min(areas,key=lambda a:np.hypot(*(np.array(a[1])-p)))[0]
    cand=[g for ci,g in hp if g.buffer(15).contains(pt)]
    if not cand: 
        cand=[min(hp,key=lambda h:h[1].distance(pt))[1]]
    col=[ci for ci,g in hp if g.equals(cand[0])][0]
    geom=unary_union([g for ci,g in hp if ci==col and g.distance(cand[0])<30])
    zones[t]={'label_area':al,'geom':geom}
import pickle; pickle.dump((parcel,zones),open('zones.pkl','wb'))
for t,z in zones.items():
    g=z['geom']; print(f"{t:32s} {z['label_area']:18s} drawn {g.area/4046.86:6.2f} ac  in-parcel {g.intersection(parcel).area/4046.86:6.2f}")
