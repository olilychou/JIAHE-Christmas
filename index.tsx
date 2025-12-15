import React, { useRef, useState, useMemo, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import { 
  OrbitControls, 
  Environment, 
  Float, 
  Stars,
  PerspectiveCamera,
  BakeShadows,
  useTexture
} from '@react-three/drei';
import { EffectComposer, Bloom, Vignette, Noise } from '@react-three/postprocessing';
import * as THREE from 'three';

// --- AESTHETIC CONFIG ---
const THEME = {
  emerald: new THREE.Color("#006b3c"), // Brighter emerald for highlights
  deepGreen: new THREE.Color("#00281f"), // Dark base
  gold: new THREE.Color("#FFD700"),
  white: new THREE.Color("#FFFFFF"),
};

// --- UTILS ---
function createPlaceholderTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#f8f8f8';
    ctx.fillRect(0, 0, 512, 512);
    // Border
    ctx.strokeStyle = '#D4AF37';
    ctx.lineWidth = 30;
    ctx.strokeRect(15, 15, 482, 482);
    
    ctx.fillStyle = '#D4AF37';
    ctx.font = 'bold 90px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('JIAHE', 256, 200);
    
    ctx.font = 'italic 50px serif';
    ctx.fillStyle = '#004526';
    ctx.fillText('Memories', 256, 280);
    
    ctx.font = '20px sans-serif';
    ctx.fillStyle = '#999';
    ctx.fillText('Tap to expand', 256, 450);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Helper to fix orientation by baking image into canvas
const processImageFile = (file: File): Promise<string> => {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    
    img.onload = () => {
      // Create canvas to bake the image data with correct orientation
      const canvas = document.createElement('canvas');
      // Limit max size to avoid massive textures (performance optimization)
      const maxSize = 2048; 
      let width = img.width;
      let height = img.height;
      
      if (width > height) {
        if (width > maxSize) {
          height *= maxSize / width;
          width = maxSize;
        }
      } else {
        if (height > maxSize) {
          width *= maxSize / height;
          height = maxSize;
        }
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
          // Drawing the image to canvas allows the browser to handle EXIF orientation automatically
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL(file.type || 'image/png'));
      } else {
          resolve(url); // Fallback
      }
      URL.revokeObjectURL(url);
    };

    img.onerror = () => {
        resolve(url); // Fallback
        URL.revokeObjectURL(url);
    }
    
    img.src = url;
  });
};

// --- SHADERS ---

// FOLIAGE: Reduced size by half per user request (300/225 instead of 600/450)
const FoliageShaderMaterial = {
  uniforms: {
    uTime: { value: 0 },
    uProgress: { value: 0 },
    uColorBase: { value: THEME.deepGreen },
    uColorTip: { value: THEME.emerald },
    uColorGold: { value: THEME.gold },
  },
  vertexShader: `
    uniform float uTime;
    uniform float uProgress;
    attribute vec3 aPosTree;
    attribute vec3 aPosScatter;
    attribute float aRandom;
    
    varying float vAlpha;
    varying float vType; // 0 = dark inner, 1 = bright outer, 2 = gold

    float easeOutCubic(float x) { return 1.0 - pow(1.0 - x, 3.0); }

    void main() {
      float t = easeOutCubic(uProgress);
      vec3 pos = mix(aPosScatter, aPosTree, t);

      // Organic wind movement
      float wind = sin(uTime * 1.5 + pos.y * 0.5 + pos.x) * 0.08;
      pos.x += wind * (1.0 - t * 0.6); 
      
      vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
      gl_Position = projectionMatrix * mvPosition;

      // Type definition
      if (aRandom > 0.95) vType = 2.0; // Gold
      else if (aRandom > 0.5) vType = 1.0; // Bright Green
      else vType = 0.0; // Dark Green

      // Size calculation - HALVED
      float sizeBase = (vType == 2.0) ? 300.0 : 225.0; 
      
      // Scale by perspective (1.0 / -z)
      gl_PointSize = (sizeBase * (0.8 + 0.4 * aRandom)) * (1.0 / -mvPosition.z);
      
      vAlpha = 0.8 + 0.2 * sin(uTime * 2.0 + aRandom * 100.0);
    }
  `,
  fragmentShader: `
    uniform vec3 uColorBase;
    uniform vec3 uColorTip;
    uniform vec3 uColorGold;
    
    varying float vAlpha;
    varying float vType;

    void main() {
      // Use a slightly squircle shape instead of perfect circle to match "voxel" feel?
      // Or keep soft circular for "fluffy" pine look. Let's keep it soft but distinct.
      vec2 coord = gl_PointCoord - vec2(0.5);
      float dist = length(coord);
      if (dist > 0.5) discard;

      vec3 color = uColorBase;
      if (vType > 1.5) color = uColorGold;
      else if (vType > 0.5) color = mix(uColorBase, uColorTip, 0.7);

      // Add a slight "structure" to the point so it looks voluminous
      float shading = 1.0 - dist * 1.5;
      color = color * shading;

      // Soft edge for snow/pine effect
      float alpha = vAlpha;
      if (dist > 0.4) alpha *= (0.5 - dist) * 10.0;

      gl_FragColor = vec4(color, alpha);
    }
  `
};

// FIREWORKS: Simple explosion shader
const FireworkShaderMaterial = {
  uniforms: {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(1, 0.5, 0.5) },
  },
  vertexShader: `
    uniform float uTime;
    attribute vec3 aVelocity;
    void main() {
      vec3 pos = position + aVelocity * uTime * 15.0;
      pos.y -= 2.0 * uTime * uTime; // Gravity
      vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      gl_PointSize = (200.0 * (1.0 - uTime)) * (1.0 / -mvPosition.z);
    }
  `,
  fragmentShader: `
    uniform vec3 uColor;
    void main() {
      vec2 coord = gl_PointCoord - vec2(0.5);
      if (length(coord) > 0.5) discard;
      gl_FragColor = vec4(uColor, 1.0);
    }
  `
};

// SNOW: Falling particles
const SnowShaderMaterial = {
  uniforms: {
    uTime: { value: 0 },
    uHeight: { value: 50 },
  },
  vertexShader: `
    uniform float uTime;
    uniform float uHeight;
    attribute vec3 aRandom; // x=speed, y=offset, z=sway
    
    void main() {
      vec3 pos = position;
      
      // Fall down
      float fall = uTime * (2.0 + aRandom.x * 3.0);
      pos.y = mod(pos.y - fall, uHeight) - (uHeight * 0.5);
      
      // Sway
      pos.x += sin(uTime + aRandom.y) * aRandom.z;
      pos.z += cos(uTime + aRandom.y) * aRandom.z;

      vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      gl_PointSize = (30.0 + aRandom.x * 20.0) * (1.0 / -mvPosition.z);
    }
  `,
  fragmentShader: `
    void main() {
      vec2 coord = gl_PointCoord - vec2(0.5);
      float dist = length(coord);
      if (dist > 0.5) discard;
      float alpha = 1.0 - (dist * 2.0);
      gl_FragColor = vec4(1.0, 1.0, 1.0, alpha * 0.8);
    }
  `
};

// --- DATA GENERATION ---

const generateFoliageData = (count: number) => {
  const positionsTree = new Float32Array(count * 3);
  const positionsScatter = new Float32Array(count * 3);
  const randoms = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const t = i / count; 
    
    // Tree: Dense Volume
    const angle = t * 250.0; // More rotations for density
    const height = 20;
    const y = (t * height) - (height / 2); // -10 to 10
    
    // "Thick Shell" Logic: Particles exist between radius*0.4 and radius*1.0
    const maxRadius = (1.0 - Math.pow(t, 0.9)) * 8.5; // Wider base
    const radiusStrata = 0.2 + 0.8 * Math.sqrt(Math.random()); // Bias towards outer edge
    const r = maxRadius * radiusStrata;

    const xTree = Math.cos(angle) * r;
    const zTree = Math.sin(angle) * r;
    
    positionsTree[i * 3] = xTree;
    positionsTree[i * 3 + 1] = y;
    positionsTree[i * 3 + 2] = zTree;

    // Scatter
    const rScatter = 40.0 * Math.cbrt(Math.random());
    const theta = Math.random() * 2 * Math.PI;
    const phi = Math.acos(2 * Math.random() - 1);
    
    positionsScatter[i * 3] = rScatter * Math.sin(phi) * Math.cos(theta);
    positionsScatter[i * 3 + 1] = rScatter * Math.sin(phi) * Math.sin(theta);
    positionsScatter[i * 3 + 2] = rScatter * Math.cos(phi);

    randoms[i] = Math.random();
  }

  return { positionsTree, positionsScatter, randoms };
};

// --- COMPONENTS ---

const Snow = () => {
  const count = 2000;
  const meshRef = useRef<THREE.Points>(null);
  
  const { positions, randoms } = useMemo(() => {
    const pos = new Float32Array(count * 3);
    const rnd = new Float32Array(count * 3);
    for(let i=0; i<count; i++){
      pos[i*3] = (Math.random() - 0.5) * 60; // x
      pos[i*3+1] = (Math.random() - 0.5) * 50; // y
      pos[i*3+2] = (Math.random() - 0.5) * 60; // z
      
      rnd[i*3] = Math.random(); // speed
      rnd[i*3+1] = Math.random() * 100; // offset
      rnd[i*3+2] = Math.random() * 0.5; // sway amt
    }
    return { positions: pos, randoms: rnd };
  }, []);

  useFrame((state) => {
    if(meshRef.current) {
      const mat = meshRef.current.material as THREE.ShaderMaterial;
      mat.uniforms.uTime.value = state.clock.elapsedTime;
    }
  });

  return (
    <points ref={meshRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={count} array={positions} itemSize={3} />
        <bufferAttribute attach="attributes-aRandom" count={count} array={randoms} itemSize={3} />
      </bufferGeometry>
      <shaderMaterial 
        attach="material"
        args={[SnowShaderMaterial]}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  )
}

const Fireworks = ({ active }: { active: boolean }) => {
  const [explosions, setExplosions] = useState<{id: number, color: THREE.Color, position: [number,number,number]}[]>([]);
  const idRef = useRef(0);

  useEffect(() => {
    if (active) {
      // Launch 3 random fireworks
      const count = 3;
      const newExps = [];
      for(let i=0; i<count; i++) {
        newExps.push({
          id: idRef.current++,
          color: new THREE.Color().setHSL(Math.random(), 1, 0.6),
          position: [(Math.random()-0.5)*20, 5 + Math.random()*10, (Math.random()-0.5)*10] as [number,number,number]
        });
      }
      setExplosions(newExps);
      
      // Clear after 2s
      const t = setTimeout(() => setExplosions([]), 2000);
      return () => clearTimeout(t);
    }
  }, [active]);

  return (
    <group>
      {explosions.map(exp => <FireworkInstance key={exp.id} {...exp} />)}
    </group>
  );
};

const FireworkInstance = ({ color, position }: { color: THREE.Color, position: [number,number,number] }) => {
  const ref = useRef<THREE.Points>(null);
  const [startTime] = useState(Date.now());
  const count = 300;
  
  const { vels } = useMemo(() => {
    const v = new Float32Array(count * 3);
    for(let i=0; i<count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const speed = Math.random() * 0.5 + 0.5;
      v[i*3] = speed * Math.sin(phi) * Math.cos(theta);
      v[i*3+1] = speed * Math.sin(phi) * Math.sin(theta);
      v[i*3+2] = speed * Math.cos(phi);
    }
    return { vels: v };
  }, []);

  useFrame(() => {
    if (ref.current) {
      const mat = ref.current.material as THREE.ShaderMaterial;
      const age = (Date.now() - startTime) / 1500; // 1.5s lifetime
      mat.uniforms.uTime.value = age;
      if (age > 1) ref.current.visible = false;
    }
  });

  return (
    <points ref={ref} position={position}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={count} array={new Float32Array(count * 3)} itemSize={3} />
        <bufferAttribute attach="attributes-aVelocity" count={count} array={vels} itemSize={3} />
      </bufferGeometry>
      <shaderMaterial args={[FireworkShaderMaterial]} uniforms-uColor-value={color} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
    </points>
  )
}

const FoliageSystem = ({ mode }: { mode: number }) => {
  const count = 64000; // HIGH DENSITY
  const shaderRef = useRef<THREE.ShaderMaterial>(null);
  const { positionsTree, positionsScatter, randoms } = useMemo(() => generateFoliageData(count), []);

  useFrame((state) => {
    if (shaderRef.current) {
      shaderRef.current.uniforms.uTime.value = state.clock.elapsedTime;
      shaderRef.current.uniforms.uProgress.value = THREE.MathUtils.lerp(
        shaderRef.current.uniforms.uProgress.value,
        mode,
        0.02
      );
    }
  });

  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={count} array={positionsTree} itemSize={3} />
        <bufferAttribute attach="attributes-aPosTree" count={count} array={positionsTree} itemSize={3} />
        <bufferAttribute attach="attributes-aPosScatter" count={count} array={positionsScatter} itemSize={3} />
        <bufferAttribute attach="attributes-aRandom" count={count} array={randoms} itemSize={1} />
      </bufferGeometry>
      <shaderMaterial
        ref={shaderRef}
        attach="material"
        args={[FoliageShaderMaterial]}
        transparent
        depthWrite={false}
      />
    </points>
  );
};

// ... OrnamentSystem (kept mostly same, just optimized render logic if needed) ...
const OrnamentSystem = ({ mode }: { mode: number }) => {
    const count = 400; // Increased slighty
    // ... Data Generation inline for brevity or reuse ...
    const data = useMemo(() => {
        const d = [];
        for(let i=0; i<count; i++) {
             // ... logic same as before ...
            const t = Math.random();
            const height = 18;
            const yTree = (t * height) - (height / 2);
            const r = (1.0 - t) * 8.0; 
            const angle = Math.random() * Math.PI * 2;
            d.push({
                treePos: new THREE.Vector3(Math.cos(angle)*r, yTree, Math.sin(angle)*r),
                scatterPos: new THREE.Vector3((Math.random()-0.5)*40, (Math.random()-0.5)*40, (Math.random()-0.5)*40),
                scale: Math.random() * 0.4 + 0.2,
                type: Math.random() > 0.6 ? 'BOX' : 'SPHERE',
                rotationSpeed: Math.random() * 0.02
            })
        }
        return d;
    }, []);

    const meshSphereRef = useRef<THREE.InstancedMesh>(null);
    const meshBoxRef = useRef<THREE.InstancedMesh>(null);
    const currentProgress = useRef(0);
    const dummy = useMemo(() => new THREE.Object3D(), []);

    useFrame(() => {
        currentProgress.current = THREE.MathUtils.lerp(currentProgress.current, mode, 0.04);
        const t = 1 - Math.pow(1 - currentProgress.current, 3);
        let b=0, s=0;
        data.forEach((item, i) => {
            dummy.position.lerpVectors(item.scatterPos, item.treePos, t);
            dummy.scale.setScalar(item.scale * (0.5 + 0.5 * t));
            dummy.rotation.x += item.rotationSpeed;
            dummy.rotation.y += item.rotationSpeed;
            dummy.updateMatrix();
            if(item.type === 'BOX' && meshBoxRef.current) meshBoxRef.current.setMatrixAt(b++, dummy.matrix);
            else if(meshSphereRef.current) meshSphereRef.current.setMatrixAt(s++, dummy.matrix);
        });
        if(meshBoxRef.current) meshBoxRef.current.instanceMatrix.needsUpdate = true;
        if(meshSphereRef.current) meshSphereRef.current.instanceMatrix.needsUpdate = true;
    });

    return (
        <group>
            <instancedMesh ref={meshSphereRef} args={[undefined, undefined, count]} castShadow receiveShadow>
                <sphereGeometry args={[0.5, 16, 16]} />
                <meshStandardMaterial color={THEME.gold} metalness={1} roughness={0.1} />
            </instancedMesh>
            <instancedMesh ref={meshBoxRef} args={[undefined, undefined, count]} castShadow receiveShadow>
                <boxGeometry args={[0.6, 0.6, 0.6]} />
                <meshStandardMaterial color="#8a0303" metalness={0.4} roughness={0.2} />
            </instancedMesh>
        </group>
    )
}

// --- POLAROID INTERACTIVE ---

const Polaroid = ({ 
  texture, 
  treePos, 
  scatterPos, 
  mode,
  index,
  isFocused,
  onClick
}: any) => {
  const groupRef = useRef<THREE.Group>(null);
  const currentProgress = useRef(0);
  const hoverRef = useRef(false);

  useFrame((state) => {
    if (!groupRef.current) return;
    
    // Smooth mode transition
    currentProgress.current = THREE.MathUtils.lerp(currentProgress.current, mode, 0.03);
    const t = 1 - Math.pow(1 - currentProgress.current, 3);
    
    // Calculate Base Position (Scatter -> Tree)
    const basePos = new THREE.Vector3().lerpVectors(scatterPos, treePos, t);
    
    // Hover animation
    const floatY = Math.sin(state.clock.elapsedTime + index) * 0.1;
    
    if (isFocused) {
        // ZOOM MODE: Move to front of camera view
        // We assume camera is at [0, 4, 30]. We put photo at [0, 5, 20]
        const targetPos = new THREE.Vector3(0, 5, 20);
        groupRef.current.position.lerp(targetPos, 0.1);
        
        const targetScale = 3.5;
        groupRef.current.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), 0.1);
        
        // Face Camera
        groupRef.current.lookAt(0, 5, 35); // Look slightly behind camera pos to be flat
        groupRef.current.rotation.z = 0; // Fix tilt
        
    } else {
        // NORMAL MODE
        groupRef.current.position.copy(basePos).setY(basePos.y + floatY);
        groupRef.current.scale.lerp(new THREE.Vector3(1, 1, 1), 0.1);

        // Rotation logic
        const time = state.clock.elapsedTime;
        const scatterRot = new THREE.Euler(time * 0.1 + index, time * 0.15 + index, 0);
        
        // Tree Rotation: Face outwards from center, but strictly UPRIGHT (z=0)
        // White space is bottom because geometry is defined that way (box center 0, texture shifted +y)
        const dummy = new THREE.Object3D();
        dummy.position.copy(groupRef.current.position);
        dummy.lookAt(0, groupRef.current.position.y, 0);
        dummy.rotation.y += Math.PI; // Flip to face out
        dummy.rotation.z = 0; // STICTLY VERTICAL

        groupRef.current.rotation.x = THREE.MathUtils.lerp(scatterRot.x, dummy.rotation.x, t);
        groupRef.current.rotation.y = THREE.MathUtils.lerp(scatterRot.y, dummy.rotation.y, t);
        groupRef.current.rotation.z = THREE.MathUtils.lerp(scatterRot.z, dummy.rotation.z, t);

        // Mouse Hover Scale
        if(hoverRef.current) {
            groupRef.current.scale.multiplyScalar(1.1);
        }
    }
  });

  return (
    <group 
        ref={groupRef} 
        onClick={(e) => { e.stopPropagation(); onClick(index); }}
        onPointerOver={() => { hoverRef.current = true; document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { hoverRef.current = false; document.body.style.cursor = 'auto'; }}
    >
      {/* Frame Body (White Polaroid) - 1.2 x 1.5. Center at 0. Bottom edge at -0.75. Top edge at +0.75 */}
      <mesh position={[0, 0, -0.01]}>
        <boxGeometry args={[1.2, 1.5, 0.05]} />
        <meshStandardMaterial color="#fff" roughness={0.4} />
      </mesh>
      {/* Image - 1.0 x 1.0. Position at y=+0.15. Top edge at +0.65. Bottom edge at -0.35.
          Top Margin = 0.75 - 0.65 = 0.10
          Bottom Margin = -0.35 - (-0.75) = 0.40 (Larger margin at bottom)
      */}
      <mesh position={[0, 0.15, 0.02]}>
        <planeGeometry args={[1.0, 1.0]} />
        <meshBasicMaterial map={texture} />
      </mesh>
    </group>
  );
};

const PhotoSystem = ({ mode, userPhotos, focusedIdx, setFocusedIdx }: any) => {
  const defaultTexture = useMemo(() => createPlaceholderTexture(), []);
  
  // Create 9 fixed slots
  const slots = useMemo(() => {
    const arr = [];
    const count = 9;
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1); // 0 to 1
      const h = 14;
      const y = (t * h) - (h / 2) + 2; // Shift up slightly
      const r = (1.0 - t * 0.8) * 8.5; 
      const angle = t * Math.PI * 4 + (i * 0.5); // Spiral
      
      arr.push({ 
        treePos: new THREE.Vector3(Math.cos(angle)*r, y, Math.sin(angle)*r),
        scatterPos: new THREE.Vector3((Math.random()-0.5)*50, (Math.random()-0.5)*30, 20 + Math.random()*10)
      });
    }
    return arr;
  }, []);

  return (
    <group>
      {slots.map((slot, i) => {
        const photoUrl = userPhotos.length > 0 ? userPhotos[i % userPhotos.length] : null;
        return (
          <PhotoWrapper 
            key={i}
            slot={slot}
            mode={mode}
            index={i}
            photoUrl={photoUrl}
            defaultTexture={defaultTexture}
            isFocused={focusedIdx === i}
            onClick={setFocusedIdx}
          />
        );
      })}
    </group>
  );
};

const PhotoWrapper = ({ slot, mode, index, photoUrl, defaultTexture, isFocused, onClick }: any) => {
    const tex = useLoader(THREE.TextureLoader, photoUrl || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
    const activeTexture = photoUrl ? tex : defaultTexture;
    if (photoUrl && tex) (tex as THREE.Texture).colorSpace = THREE.SRGBColorSpace;

    return (
        <Polaroid 
            texture={activeTexture}
            treePos={slot.treePos}
            scatterPos={slot.scatterPos}
            mode={mode}
            index={index}
            isFocused={isFocused}
            onClick={onClick}
        />
    )
}

const Experience = ({ mode, userPhotos }: any) => {
  const [focusedIdx, setFocusedIdx] = useState<number | null>(null);
  const [fireworksActive, setFireworksActive] = useState(false);

  const handlePhotoClick = (idx: number) => {
      if (focusedIdx === idx) {
          setFocusedIdx(null); // Unzoom
      } else {
          setFocusedIdx(idx); // Zoom
          setFireworksActive(true); // Trigger FX
          setTimeout(() => setFireworksActive(false), 100); // Reset trigger
      }
  };

  // Click background to dismiss
  const handleMissed = () => setFocusedIdx(null);

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 4, 30]} fov={45} />
      {/* Disable controls when focused to prevent dragging away from photo */}
      <OrbitControls 
        enablePan={false} 
        minDistance={10} 
        maxDistance={40} 
        maxPolarAngle={Math.PI / 1.8}
        autoRotate={mode === 1 && focusedIdx === null}
        autoRotateSpeed={0.8}
        enabled={focusedIdx === null} // Lock camera when zoomed
      />

      {/* Lights */}
      <ambientLight intensity={0.2} />
      <spotLight position={[20, 50, 10]} angle={0.25} penumbra={1} intensity={2000} color={THEME.gold} castShadow shadow-bias={-0.0001} />
      <pointLight position={[-15, 5, -15]} intensity={500} color="#00ffaa" distance={30} />
      <pointLight position={[15, 10, 15]} intensity={500} color="#ff0088" distance={30} />

      <Environment preset="city" />

      {/* Main Scene Group */}
      <Float speed={focusedIdx === null ? 2 : 0} rotationIntensity={focusedIdx === null ? 0.2 : 0} floatIntensity={focusedIdx === null ? 0.2 : 0}>
        <group position={[0, -5, 0]}>
           <FoliageSystem mode={mode} />
           <OrnamentSystem mode={mode} />
           <PhotoSystem 
             mode={mode} 
             userPhotos={userPhotos} 
             focusedIdx={focusedIdx}
             setFocusedIdx={handlePhotoClick}
           />
           
           {/* Topper */}
           <group position={[0, 9.5, 0]} scale={mode}>
             <mesh>
               <dodecahedronGeometry args={[0.8, 0]} />
               <meshStandardMaterial color={THEME.white} emissive={THEME.gold} emissiveIntensity={3} toneMapped={false} />
             </mesh>
             <pointLight intensity={10} distance={15} color="#ffd700" />
           </group>
        </group>
      </Float>

      {/* Effects Layer */}
      <Fireworks active={fireworksActive} />
      <Snow />
      <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
      
      {/* Invisible Click Catcher for dismiss */}
      {focusedIdx !== null && (
          <mesh position={[0, 0, 15]} onClick={handleMissed} visible={false}>
              <planeGeometry args={[100, 100]} />
          </mesh>
      )}

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -10, 0]} receiveShadow>
        <planeGeometry args={[100, 100]} />
        <meshStandardMaterial color="#000000" roughness={0.01} metalness={0.8} />
      </mesh>
      
      <BakeShadows />
    </>
  );
};

// --- AUDIO COMPONENT ---
const BackgroundMusic = () => {
    const [playing, setPlaying] = useState(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    useEffect(() => {
        // Kevin MacLeod "Jingle Bells" (Creative Commons)
        const url = "https://upload.wikimedia.org/wikipedia/commons/e/e9/Jingle_Bells_by_Kevin_MacLeod.ogg";
        audioRef.current = new Audio(url);
        audioRef.current.loop = true;
        audioRef.current.volume = 0.5;
        
        return () => {
            if(audioRef.current) {
                audioRef.current.pause();
                audioRef.current = null;
            }
        }
    }, []);

    const toggle = () => {
        if(!audioRef.current) return;
        if(playing) {
            audioRef.current.pause();
        } else {
            audioRef.current.play().catch(e => console.error("Audio play failed", e));
        }
        setPlaying(!playing);
    }

    return (
        <button 
            onClick={toggle}
            className="fixed bottom-8 right-8 z-50 p-4 rounded-full bg-black/40 backdrop-blur-md border border-yellow-600/30 text-yellow-100 hover:bg-yellow-900/40 hover:text-white transition-all duration-300 group"
            title={playing ? "Mute Music" : "Play Jingle Bells"}
        >
            {playing ? (
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
                </svg>
            ) : (
                 <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
                </svg>
            )}
        </button>
    )
}

const UI = ({ mode, setMode, onUpload }: { mode: number, setMode: (m: number) => void, onUpload: (e: any) => void }) => {
  return (
    <div className="absolute inset-0 pointer-events-none z-10">
      <header className="absolute top-8 left-0 right-0 text-center">
        <div className="flex items-center justify-center gap-4 mb-2">
           <div className="h-[1px] w-12 bg-yellow-500 opacity-50"></div>
           {/* UPDATED TO 2025 */}
           <span className="text-yellow-500/80 tracking-[0.4em] text-xs font-serif uppercase">The 2025 Collection</span>
           <div className="h-[1px] w-12 bg-yellow-500 opacity-50"></div>
        </div>
        <h1 className="text-4xl md:text-6xl font-serif text-white gold-text drop-shadow-2xl tracking-tighter">
          JIAHE <span className="italic font-thin text-2xl md:text-4xl block mt-2">wishes you a Merry Christmas!</span>
        </h1>
      </header>

      <div className="absolute bottom-4 left-0 right-0 flex flex-col items-center gap-6 pointer-events-auto">
        <div className="flex gap-4">
            <button 
            onClick={() => setMode(mode === 0 ? 1 : 0)}
            className="group relative px-8 py-4 bg-black/40 backdrop-blur-xl border border-yellow-600/30 rounded-full transition-all duration-500 hover:bg-yellow-900/20 hover:border-yellow-500 hover:shadow-[0_0_30px_rgba(212,175,55,0.3)] overflow-hidden"
            >
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-yellow-400/10 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700"></div>
            <span className="font-serif text-yellow-100 tracking-widest text-sm uppercase group-hover:text-white transition-colors">
                {mode === 0 ? "Assemble Tree" : "Release Magic"}
            </span>
            </button>

            <label className="group relative px-8 py-4 bg-emerald-900/40 backdrop-blur-xl border border-emerald-600/30 rounded-full transition-all duration-500 hover:bg-emerald-900/60 hover:border-emerald-500 hover:shadow-[0_0_30px_rgba(16,185,129,0.3)] overflow-hidden cursor-pointer">
                <input type="file" multiple accept="image/*" className="hidden" onChange={onUpload} />
                <span className="font-serif text-emerald-100 tracking-widest text-sm uppercase group-hover:text-white transition-colors">
                    Add Photos (9 Max)
                </span>
            </label>
        </div>

        <p className="text-white/30 text-xs font-serif italic max-w-xs text-center">
          Tap photos to explore memories.
        </p>
      </div>
      
      {/* Background Music Toggle */}
      <div className="pointer-events-auto">
          <BackgroundMusic />
      </div>
    </div>
  );
};

const App = () => {
  const [mode, setMode] = useState(0);
  const [userPhotos, setUserPhotos] = useState<string[]>([]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
          // Process multiple files ensuring correct orientation
          const processedPromises = Array.from(files).map(processImageFile);
          const results = await Promise.all(processedPromises);

          setUserPhotos(prev => {
             const next = [...prev, ...results];
             return next.slice(-9); // Keep last 9
          });
          if (mode === 0) setMode(1);
      }
  };

  return (
    <div className="w-full h-full relative bg-[#00100a]">
      <Canvas shadows dpr={[1, 2]} gl={{ antialias: false, toneMapping: THREE.ReinhardToneMapping, toneMappingExposure: 1.5 }}>
        <React.Suspense fallback={null}>
            <Experience mode={mode} userPhotos={userPhotos} />
        </React.Suspense>
        
        <EffectComposer enableNormalPass={false}>
           <Bloom luminanceThreshold={1.1} mipmapBlur intensity={1.5} radius={0.6} />
           <Noise opacity={0.05} />
           <Vignette eskil={false} offset={0.1} darkness={1.0} />
        </EffectComposer>
      </Canvas>
      <UI mode={mode} setMode={setMode} onUpload={handleUpload} />
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
