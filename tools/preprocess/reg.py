import json,numpy as np
from scipy.spatial import cKDTree
from scipy.optimize import minimize
lv=json.load(open('lv_flat.json')); zp=json.load(open('zp_flat.json'))
def dens(P,step=2):
    out=[]
    for a,b in zip(P[:-1],P[1:]):
        a=np.array(a);b=np.array(b);n=max(1,int(np.linalg.norm(b-a)/step))
        out+= [a+(b-a)*t for t in np.linspace(0,1,n,endpoint=False)]
    out.append(np.array(P[-1])); return out
BD=np.array([p for o in lv if o[1]=='BD' and o[0]=='pl' for p in dens(o[2])])
RD=np.array([p for o in lv if o[1]=='RD' and o[0]=='pl' for p in dens(o[2])])
Z=[]
for o in zp:
    if o[0]=='pl' and all(24000<p[0]<26500 for p in o[2]):
        P=o[2]+([o[2][0]] if o[3] else []); Z+=dens(P)
Z=np.array(Z); print(len(BD),len(Z))
tree=cKDTree(Z)
cB=BD.mean(0)
def tf(params,P):
    dx,dy,th=params; c,s=np.cos(th),np.sin(th)
    Q=P-cB; return np.c_[c*Q[:,0]-s*Q[:,1], s*Q[:,0]+c*Q[:,1]]+[dx,dy]
def cost(p):
    d,_=tree.query(tf(p,BD)); return np.mean(np.minimum(d,15))
zc=Z.mean(0)
best=None
for th in np.radians(np.arange(-20,21,2.5)):
  for dx in np.arange(zc[0]-200,zc[0]+201,25):
    for dy in np.arange(zc[1]-200,zc[1]+201,25):
        c=cost((dx,dy,th))
        if best is None or c<best[0]: best=(c,(dx,dy,th))
print('coarse',best[0],best[1][0],best[1][1],np.degrees(best[1][2]))
r=minimize(cost,best[1],method='Nelder-Mead',options={'xatol':.01,'fatol':1e-4,'maxiter':3000})
p=r.x; print('fine',r.fun,p[:2],np.degrees(p[2]))
d,_=tree.query(tf(p,BD)); print('BD->zoning dist pct',np.percentile(d,[25,50,75,90]))
json.dump({'dx':p[0],'dy':p[1],'th':p[2],'cB':cB.tolist()},open('reg.json','w'))
def tf2(q,P):
    dx,dy,th,sc=q; return (tf((0,0,th),P))*sc+[dx,dy]
def cost2(q):
    d,_=tree.query(tf2(q,BD)); return np.mean(np.minimum(d,8))
best=None
for th0 in np.radians(np.arange(-6,6.1,1)):
    r=minimize(cost2,(p[0],p[1],th0,1.0),method='Nelder-Mead',options={'xatol':.005,'fatol':1e-5,'maxiter':4000})
    if best is None or r.fun<best.fun: best=r
q=best.x; print('scale fit',best.fun,q[:2],np.degrees(q[2]),q[3])
d,_=tree.query(tf2(q,BD)); print('pct',np.percentile(d,[25,50,75,90]))
json.dump({'dx':q[0],'dy':q[1],'th':q[2],'sc':q[3],'cB':cB.tolist()},open('reg.json','w'))
