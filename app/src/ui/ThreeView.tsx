import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useSite } from '../state/store';
import { useLayout } from '../state/layoutStore';
import { buildMassingScene } from '../engine/export/glb';
import { bboxOfMulti, bboxUnion } from '../engine/geom/planar';
import type { Bbox } from '../engine/geom/types';

/**
 * 3D terrain and massing. The same scene the GLB export writes, so what is on
 * screen is what lands in Rhino.
 */
export default function ThreeView(): React.ReactElement {
  const wrapRef = useRef<HTMLDivElement>(null);
  const site = useSite((s) => s.site);
  const byZone = useLayout((s) => s.byZone);
  const activeIndex = useLayout((s) => s.activeOptionIndex);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !site) return;

    const layouts = Object.values(byZone)
      .map((options) => options[Math.min(activeIndex, options.length - 1)])
      .filter((o): o is NonNullable<typeof o> => Boolean(o));

    const scene = buildMassingScene({ dem: site.dem, layouts, parcel: site.parcel, terrainStep: 4 });
    scene.background = new THREE.Color(0x0f1518);
    scene.fog = new THREE.Fog(0x0f1518, 900, 2400);

    const hemi = new THREE.HemisphereLight(0xbcd3dd, 0x2a3338, 1.1);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff3e0, 1.5);
    // Kerala: the sun is high and a little south of overhead.
    sun.position.set(-300, 700, 450);
    scene.add(sun);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(wrap.clientWidth, wrap.clientHeight);
    wrap.appendChild(renderer.domElement);

    const camera = new THREE.PerspectiveCamera(45, wrap.clientWidth / wrap.clientHeight, 1, 6000);
    // Frame what has been generated; fall back to the whole parcel when there
    // is nothing to look at yet.
    const b: Bbox = layouts.length
      ? layouts
          .map((l) => bboxOfMulti(l.buildable))
          .reduce((acc, box) => bboxUnion(acc, box))
      : bboxOfMulti(site.parcel);
    const centreRl = site.dem.sampleBilinear([(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]);
    const centre = new THREE.Vector3(
      (b.minX + b.maxX) / 2,
      Number.isFinite(centreRl) ? centreRl : 100,
      -(b.minY + b.maxY) / 2,
    );
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    camera.position.set(centre.x - span * 0.5, centre.y + span * 0.55, centre.z + span * 0.75);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(centre);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.update();

    let frame = 0;
    const tick = (): void => {
      frame = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    const resize = (): void => {
      camera.aspect = wrap.clientWidth / wrap.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(wrap.clientWidth, wrap.clientHeight);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const material = obj.material;
          if (Array.isArray(material)) material.forEach((m) => m.dispose());
          else material.dispose();
        }
      });
      wrap.removeChild(renderer.domElement);
    };
  }, [site, byZone, activeIndex]);

  return (
    <div ref={wrapRef} className="relative h-full w-full bg-ink">
      <div className="pointer-events-none absolute bottom-3 left-3 rounded border border-line bg-panel/90 px-2 py-1 text-[11px] text-muted">
        Drag to orbit, scroll to zoom. Terrain is the 2 m DEM; unsurveyed ground is left open rather than filled.
        Levels are RL on the assumed TBM datum.
      </div>
    </div>
  );
}
