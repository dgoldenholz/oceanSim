(function () {
  'use strict';
  const template = document.getElementById('surf-page-template');
  document.querySelector('.app-shell').appendChild(template.content.cloneNode(true));
  const P = window.SurfPhysics;
  const $ = id => document.getElementById(id);
  const viewport = $('surf-viewport');
  const audio = new window.SurfAudio();
  let world, scene, camera, renderer, water, sand, sky, spray, shore, wetTexture;
  const soundMarkers = [];
  let active = false, paused = false, failed = false, initialized = false;
  let lastFrame = 0, accumulator = 0, uiClock = 0, fps = 60;
  let drag = null;
  const held = new Set();
  const visuals = new Map();
  const particles = [];
  const observer = { x: 0, y: 2.38, z: 8, yaw: 0, pitch: -0.065 };
  const VERTEX = `
    varying vec3 worldPosition;
    void main() {
      vec4 p = modelMatrix * vec4(position, 1.0);
      worldPosition = p.xyz;
      gl_Position = projectionMatrix * viewMatrix * p;
    }`;
  const NOISE = `
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
    }
    float fbm(vec2 p) { return noise(p)*0.55+noise(p*2.07)*0.27+noise(p*4.1)*0.12+noise(p*8.3)*0.06; }
  `;
  const WATER_FRAGMENT = `
    varying vec3 worldPosition; varying vec3 waterNormal; varying float foamAmount; varying float fluidDepth;
    uniform float time; uniform float wind; uniform float sheet; uniform float baseWater; uniform vec2 windVector; ${NOISE}
    void main() {
      vec3 p=worldPosition;
      if(baseWater>0.5 && abs(p.x)<80.0 && p.z>-8.0)discard;
      if(sheet>0.5 && fluidDepth<0.002)discard;
      float dist=length(cameraPosition-p);
      vec2 uv=p.xz*1.2-windVector*0.045;
      float detail=1.0-smoothstep(12.0,150.0,dist);
      float nx=noise(uv+vec2(0.12,0))-noise(uv-vec2(0.12,0));
      float nz=noise(uv+vec2(0,0.12))-noise(uv-vec2(0,0.12));
      vec3 n=normalize(waterNormal+vec3(nx,0,nz)*wind*0.07*detail);
      if(n.y<0.0)n=-n;
      vec3 eye=normalize(cameraPosition-p);
      float fresnel=0.025+0.975*pow(1.0-max(0.0,dot(n,eye)),5.0);
      float depth=smoothstep(0.0,28.0,-p.z);
      vec3 body=mix(vec3(0.12,0.29,0.23),vec3(0.028,0.13,0.16),depth);
      vec3 reflection=mix(vec3(0.22,0.39,0.46),vec3(0.53,0.66,0.69),max(0.0,n.y));
      vec3 col=mix(body,reflection,fresnel*0.90);
      vec3 sun=normalize(vec3(-0.4,0.28,-1.0));
      float glint=pow(max(0.0,dot(reflect(-sun,n),eye)),90.0)*detail;
      col+=vec3(0.40,0.34,0.22)*glint;
      float cells=fbm(p.xz*2.7+vec2(time*0.12,-time*0.26));
      float lace=smoothstep(0.36,0.66,cells);
      float edgeFoam=sheet*(1.0-smoothstep(0.018,0.08,fluidDepth))*smoothstep(0.002,0.012,fluidDepth);
      float foam=max(smoothstep(0.04,0.60,foamAmount),edgeFoam)*(0.16+0.84*lace);
      col=mix(col,vec3(0.79,0.85,0.79),foam);
      col=mix(col,vec3(0.65,0.78,0.79),1.0-exp(-dist*0.0025));
      float alpha=mix(1.0,clamp(1.0-exp(-fluidDepth*12.0)+foam*0.75,0.0,0.98),sheet);
      gl_FragColor=vec4(col,alpha);
      #include <colorspace_fragment>
    }
  `;

  function message(text) { $('surf-message').textContent = text; $('surf-message').hidden = !text; }

  function makeSky() {
    const material = new THREE.ShaderMaterial({ side: THREE.BackSide,
      uniforms: { time: { value: 0 } }, vertexShader: VERTEX,
      fragmentShader: `varying vec3 worldPosition; uniform float time; ${NOISE}
      void main() {
        vec3 ray=normalize(worldPosition-cameraPosition);
        float up=max(0.0,ray.y);
        vec3 color=mix(vec3(0.79,0.86,0.84),vec3(0.22,0.47,0.67),pow(up,0.55));
        float sun=pow(max(0.0,dot(ray,normalize(vec3(-0.4,0.28,-1.0)))),450.0);
        color+=vec3(1.0,0.83,0.58)*sun*0.65;
        vec2 uv=ray.xz/max(0.12,ray.y)*1.8+vec2(0.0,time*0.001);
        float clouds=smoothstep(0.51,0.77,fbm(uv))*smoothstep(0.02,0.2,up);
        color=mix(color,vec3(0.90,0.92,0.87),clouds*0.65);
        gl_FragColor=vec4(color,1.0);
        #include <colorspace_fragment>
      }` });
    sky = new THREE.Mesh(new THREE.SphereGeometry(1400, 24, 16), material);
    scene.add(sky);
  }

  function makeSand() {
    const geometry = new THREE.PlaneGeometry(1800, 1500, 160, 180);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, 0, 150);
    const a = geometry.attributes.position;
    for (let i = 0; i < a.count; i++) {
      const x=a.getX(i), z=a.getZ(i);
      a.setY(i, P.terrainHeight(x,z));
    }
    geometry.computeVertexNormals();
    const wet = Array.from({length: P.SEGMENTS}, () => 0);
    const material = new THREE.ShaderMaterial({ vertexShader: VERTEX,
      uniforms: { wet: { value: wet }, wetMap: {value:wetTexture}, nearShore:{value:0} },
      fragmentShader: `varying vec3 worldPosition; uniform float wet[41]; uniform sampler2D wetMap; uniform float nearShore; ${NOISE}
      void main() {
        vec3 p=worldPosition;
        bool local=abs(p.x)<80.0 && p.z>-8.0 && p.z<12.0;
        if(local && nearShore<0.5)discard;
        int idx=int(clamp(floor((p.x+80.0)/4.0),0.0,40.0));
        float wetEdge=wet[idx];
        float damp=1.0-smoothstep(wetEdge,wetEdge+1.2,p.z);
        if(local)damp=texture2D(wetMap,vec2((p.z+8.125)/20.25,(p.x+82.0)/164.0)).r;
        float grain=noise(p.xz*105.0)*0.09+noise(p.xz*24.0)*0.07;
        float ridges=sin(p.x*23.0+sin(p.z*1.7)*0.6)*0.012;
        vec3 dry=vec3(0.68,0.56,0.37)+grain+ridges;
        vec3 moist=vec3(0.38,0.33,0.23)+grain*0.6;
        vec3 col=mix(dry,moist,damp*0.78);
        vec3 eye=normalize(cameraPosition-p);
        float sheen=pow(1.0-max(0.0,eye.y),7.0)*damp;
        col=mix(col,vec3(0.53,0.65,0.67),sheen*0.30);
        float dist=length(p-cameraPosition);
        col=mix(col,vec3(0.65,0.78,0.79),1.0-exp(-dist*0.0015));
        gl_FragColor=vec4(col,1.0);
        #include <colorspace_fragment>
      }` });
    sand = new THREE.Mesh(geometry, material);
    scene.add(sand);
  }

  function makeWater() {
    const geometry = new THREE.PlaneGeometry(2000, 1600, 160, 160);
    geometry.rotateX(-Math.PI/2); geometry.translate(0, -0.025, -800);
    const material = new THREE.ShaderMaterial({ side: THREE.DoubleSide,
      uniforms: { time: { value: 0 }, wind: { value: 12 }, sheet: { value: 0 }, baseWater:{value:1}, windVector:{value:new THREE.Vector2(0,12)} },
      vertexShader: `varying vec3 worldPosition; varying vec3 waterNormal; varying float foamAmount; varying float fluidDepth;
        uniform float time; uniform float wind;
        void main() {
          vec3 p=position;
          float shallow=smoothstep(0.0,8.0,-p.z);
          p.y+=shallow*wind*0.002*(sin(p.x*0.65+p.z*1.2-time*2.9)+sin(p.x*1.7-p.z*0.9+time*3.2));
          worldPosition=p;
          waterNormal=vec3(0,1,0);foamAmount=0.0;fluidDepth=10.0;
          gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
        }`,
      fragmentShader: WATER_FRAGMENT });
    water = new THREE.Mesh(geometry, material); scene.add(water);
  }

  function ribbon(front) {
    const cols = 17, rows = P.SEGMENTS;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(cols*rows*3), colors = new Float32Array(cols*rows*3);
    const indices = [];
    for(let i=0;i<rows-1;i++) for(let j=0;j<cols-1;j++) {
      const k=i*cols+j; indices.push(k,k+cols,k+1,k+1,k+cols,k+cols+1);
    }
    geometry.setAttribute('position',new THREE.BufferAttribute(positions,3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('color',new THREE.BufferAttribute(colors,3).setUsage(THREE.DynamicDrawUsage));
    geometry.setIndex(indices);
    const material = new THREE.ShaderMaterial({ vertexColors:true, side:THREE.DoubleSide,
      uniforms: { time:{value:0},wind:{value:12},sheet:{value:0},baseWater:{value:0},windVector:{value:new THREE.Vector2(0,12)} }, fragmentShader:WATER_FRAGMENT,
      vertexShader:`varying vec3 worldPosition; varying vec3 waterNormal; varying float foamAmount; varying float fluidDepth;
        void main() {
          worldPosition=position;waterNormal=normal;foamAmount=color.r;fluidDepth=color.b;
          gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
        }` });
    const mesh=new THREE.Mesh(geometry,material); mesh.frustumCulled=false; scene.add(mesh);
    return { mesh, cols };
  }

  function drawFront(front, visual) {
    const positions=visual.mesh.geometry.attributes.position;
    const colors=visual.mesh.geometry.attributes.color;
    visual.mesh.material.uniforms.time.value=world.time;
    visual.mesh.material.uniforms.wind.value=world.gust.speed;
    visual.mesh.material.uniforms.windVector.value.set(world.windOffset.x,world.windOffset.z);
    for(let i=0;i<P.SEGMENTS;i++) {
      const s=front.segments[i];
      const edge=Math.sin(Math.PI*i/(P.SEGMENTS-1)) ** 0.35;
      for(let j=0;j<visual.cols;j++) {
        const q=j/(visual.cols-1), t=(q-0.5)*2;
        let z=s.z+t*s.width;
        const crest=Math.exp(-t*t*7);
        let y=0.50*s.height*crest*edge;
        const curl=s.breaking ? Math.sin(Math.min(1,s.breakAge/0.75)*Math.PI)*s.impactHeight*0.42 : 0;
        if(q>0.42&&q<0.75) {
          z+=curl*Math.sin((q-0.42)/0.33*Math.PI);
          y+=curl*Math.cos((q-0.42)/0.33*Math.PI)*0.4;
        }
        if(s.runup) y=0;
        const foam=s.foam*crest;
        y+=foam*0.065;
        // Collapse inactive ribbons below the water rather than leaving a flat strip on sand.
        if(s.runup||s.z<-120||z>-6) y=-2;
        positions.setXYZ(i*visual.cols+j,s.x,y,z);
        colors.setXYZ(i*visual.cols+j,foam,foam,foam);
      }
    }
    positions.needsUpdate=colors.needsUpdate=true;
    visual.mesh.geometry.computeVertexNormals();
  }

  function makeShore() {
    const field=world.swash, rows=81, cols=field.nz;
    const geometry=new THREE.BufferGeometry(), positions=new Float32Array(rows*cols*3);
    const indices=[];
    for(let x=0;x<rows;x++)for(let z=0;z<cols;z++) {
      const k=x*cols+z, px=-80+x*2, pz=field.zMin+z*field.dz;
      positions.set([px,P.bedHeight(px,pz),pz],k*3);
      if(x<rows-1&&z<cols-1)indices.push(k,k+cols,k+1,k+1,k+cols,k+cols+1);
    }
    geometry.setAttribute('position',new THREE.BufferAttribute(positions,3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('color',new THREE.BufferAttribute(new Float32Array(positions.length),3).setUsage(THREE.DynamicDrawUsage));
    geometry.setIndex(indices);geometry.computeVertexNormals();
    const groundMaterial=sand.material.clone();groundMaterial.uniforms.nearShore.value=1;
    groundMaterial.side=THREE.DoubleSide;
    groundMaterial.uniforms.wetMap.value=wetTexture;
    scene.add(new THREE.Mesh(geometry.clone(),groundMaterial));
    const temporary=ribbon({});
    const material=temporary.mesh.material.clone();
    scene.remove(temporary.mesh);temporary.mesh.geometry.dispose();temporary.mesh.material.dispose();
    material.uniforms.sheet.value=1;material.transparent=true;material.depthWrite=false;
    shore=new THREE.Mesh(geometry,material);shore.frustumCulled=false;shore.renderOrder=2;scene.add(shore);
    for(let i=0;i<3;i++) {
      const marker=new THREE.Mesh(new THREE.RingGeometry(0.8,0.95,40),
        new THREE.MeshBasicMaterial({color:0xf9cf88,transparent:true,opacity:0.5,side:THREE.DoubleSide,depthWrite:false,depthTest:false}));
      marker.renderOrder=5;
      marker.rotation.x=-Math.PI/2;marker.visible=false;scene.add(marker);soundMarkers.push(marker);
    }
  }

  function drawShore() {
    const field=world.swash, positions=shore.geometry.attributes.position, colors=shore.geometry.attributes.color;
    for(let x=0;x<81;x++)for(let z=0;z<field.nz;z++) {
      const row=x/2, left=Math.floor(row), right=Math.min(40,left+1), f=row-left;
      const a=left*field.nz+z,b=right*field.nz+z,k=x*field.nz+z;
      const px=-80+x*2,pz=field.zMin+z*field.dz,bed=P.bedHeight(px,pz);
      const eta=P.mix(field.h[a]+field.bed[a],field.h[b]+field.bed[b],f);
      const h=Math.max(0,eta-bed);
      const foam=P.mix(field.foam[a],field.foam[b],f);
      const flow=P.mix(field.qz[a],field.qz[b],f)/Math.max(0.01,h);
      const ripple=Math.sin(px*9+pz*21-world.time*flow*4)*Math.min(0.008,h*0.08);
      positions.setY(k,bed+h+0.003+ripple);
      colors.setXYZ(k,foam,flow,h);
    }
    positions.needsUpdate=colors.needsUpdate=true;shore.geometry.computeVertexNormals();
    for(let k=0;k<field.h.length;k++)wetTexture.image.data[k*4]=Math.round(field.wet[k]*255);
    wetTexture.needsUpdate=true;
    shore.material.uniforms.time.value=world.time;
    shore.material.uniforms.wind.value=world.gust.speed;
    shore.material.uniforms.windVector.value.set(world.windOffset.x,world.windOffset.z);
    const sources=audio.audibleSources();
    soundMarkers.forEach((marker,i)=>{
      const source=sources[i];marker.visible=!!source && $('surf-origins').checked && !paused;
      if(!source)return;
      marker.position.set(source.x,source.y+0.08,source.z);
      marker.material.color.setHex(source.kind==='wash'?0xace8e4:0xf9cf88);
      marker.quaternion.copy(camera.quaternion);
      marker.material.opacity=P.clamp(source.score*12,0.35,0.85);
      marker.scale.setScalar(Math.max(0.6,camera.position.distanceTo(marker.position)*0.020));
    });
  }

  function makeSpray() {
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(2400*3),3).setUsage(THREE.DynamicDrawUsage));
    const textureCanvas=document.createElement('canvas'); textureCanvas.width=32;textureCanvas.height=32;
    const ctx=textureCanvas.getContext('2d'), g=ctx.createRadialGradient(16,16,1,16,16,15);
    g.addColorStop(0,'rgba(255,255,255,0.9)');g.addColorStop(0.35,'rgba(255,255,255,0.5)');g.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=g;ctx.fillRect(0,0,32,32);
    const material=new THREE.PointsMaterial({size:0.12,map:new THREE.CanvasTexture(textureCanvas),
      color:0xeaf1e9,transparent:true,opacity:0.72,depthWrite:false,sizeAttenuation:true});
    spray=new THREE.Points(geometry,material);spray.frustumCulled=false;spray.renderOrder=3;scene.add(spray);
  }

  function splash(event) {
    const rng=P.random(event.frontId*391+event.index);
    const count=Math.round(P.clamp(event.height*13,5,28));
    for(let i=0;i<count&&particles.length<2300;i++) particles.push({
      x:event.x+(rng()-0.5)*P.DX,y:event.y,z:event.z,
      vx:(rng()-0.5)*1.8,vy:1+rng()*Math.sqrt(P.G*event.height)*0.7,
      vz:0.8+rng()*1.4,life:1.8+rng(),age:0 });
  }

  function updateSpray(dt) {
    const a=spray.geometry.attributes.position;
    for(let i=particles.length-1;i>=0;i--) {
      const p=particles[i]; p.age+=dt;
      p.vx+=(world.gust.vector.x*0.35-p.vx)*dt*0.4;
      p.vz+=(world.gust.vector.z*0.35-p.vz)*dt*0.4; p.vy-=P.G*dt;
      p.x+=p.vx*dt;p.y+=p.vy*dt;p.z+=p.vz*dt;
      if(p.age>p.life||p.y<Math.max(0,P.bedHeight(p.x,p.z))) particles.splice(i,1);
    }
    particles.forEach((p,i)=>a.setXYZ(i,p.x,p.y,p.z));
    a.needsUpdate=true;spray.geometry.setDrawRange(0,particles.length);
  }

  function init() {
    if(initialized||failed) return;
    try {
      if(!window.THREE) throw new Error('The local 3D renderer did not load.');
      renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'});
      renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.5));
      renderer.outputColorSpace=THREE.SRGBColorSpace;
      renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;
      renderer.domElement.setAttribute('aria-hidden','true');viewport.prepend(renderer.domElement);
      scene=new THREE.Scene();scene.fog=new THREE.FogExp2(0xa9c6c9,0.0025);
      camera=new THREE.PerspectiveCamera(62,1,0.08,2000);camera.rotation.order='YXZ';
      scene.add(new THREE.HemisphereLight(0xc4e0ed,0x9c8357,2.4));
      const sun=new THREE.DirectionalLight(0xffedce,2.0);sun.position.set(-100,80,-180);scene.add(sun);
      const seed=window.crypto?.getRandomValues ? window.crypto.getRandomValues(new Uint32Array(1))[0] : Date.now();
      world=new P.Ocean(seed);
      wetTexture=new THREE.DataTexture(new Uint8Array(world.swash.h.length*4),world.swash.nz,world.swash.nx);
      wetTexture.minFilter=wetTexture.magFilter=THREE.LinearFilter;
      makeSky();makeSand();makeWater();makeShore();makeSpray();
      new ResizeObserver(resize).observe(viewport);
      renderer.domElement.addEventListener('webglcontextlost',event=>{
        event.preventDefault();failed=true;audio.silence();message('The 3D view lost its graphics context. Reload the page to restart it.');
      });
      initialized=true;resize();
    } catch(error) { failed=true; message(`The 3D view could not start. ${error.message} Enable hardware graphics support and reload.`); console.error(error); }
  }

  function resize() {
    if(!renderer||!viewport.clientWidth||!viewport.clientHeight) return;
    renderer.setSize(viewport.clientWidth,viewport.clientHeight,false);
    camera.aspect=viewport.clientWidth/viewport.clientHeight;camera.updateProjectionMatrix();
  }

  async function unlockAudio() {
    if(!active||paused||failed) return;
    try {
      await audio.activate();
      if(!active||paused) { audio.silence();return; }
      message('');
    } catch(error) { message('Tap the view to enable stereo sound.'); console.warn(error.message); }
  }

  function setActive(value) {
    active=value;held.clear();drag=null;lastFrame=performance.now();accumulator=0;
    if(value) {
      init(); if(failed)return;
      resize();viewport.focus({preventScroll:true});unlockAudio();
    } else {
      audio.silence();
      if(document.fullscreenElement===viewport)document.exitFullscreen().catch(()=>{});
    }
  }

  function walk(dt) {
    let forward=0,right=0;
    if(held.has('forward'))forward++;if(held.has('back'))forward--;
    if(held.has('right'))right++;if(held.has('left'))right--;
    const len=Math.max(1,Math.hypot(forward,right));
    observer.x+=(Math.sin(observer.yaw)*forward+Math.cos(observer.yaw)*right)*2.1*dt/len;
    observer.z+=(-Math.cos(observer.yaw)*forward+Math.sin(observer.yaw)*right)*2.1*dt/len;
    observer.x=P.clamp(observer.x,-60,60);observer.z=P.clamp(observer.z,2.4,28);
    observer.y=P.terrainHeight(observer.x,observer.z)+1.7;
  }

  function turn(amount) { observer.yaw=(observer.yaw+amount+Math.PI*2)%(Math.PI*2); }
  const movement={w:'forward',arrowup:'forward',s:'back',arrowdown:'back',a:'left',arrowleft:'left',d:'right',arrowright:'right'};
  document.addEventListener('keydown',e=>{
    if(!active||e.target.closest('input,select,textarea,button,summary'))return;
    const key=e.key.toLowerCase();
    if(movement[key]) {e.preventDefault();held.add(movement[key]);}
    if((key==='q'||key==='e')&&!e.repeat) {e.preventDefault();turn((key==='q'?-1:1)*Math.PI/12);}
  });
  document.addEventListener('keyup',e=>{if(movement[e.key.toLowerCase()])held.delete(movement[e.key.toLowerCase()]);});
  window.addEventListener('blur',()=>{held.clear();drag=null;});
  document.addEventListener('visibilitychange',()=>{
    held.clear();lastFrame=performance.now();
    if(document.hidden)audio.silence();else if(active&&!paused)unlockAudio();
  });
  viewport.addEventListener('pointerdown',e=>{
    if(e.target.closest('button'))return;
    viewport.focus({preventScroll:true});unlockAudio();
    drag={id:e.pointerId,x:e.clientX,y:e.clientY};viewport.setPointerCapture(e.pointerId);
  });
  viewport.addEventListener('pointermove',e=>{
    if(!drag||drag.id!==e.pointerId)return;
    turn(-(e.clientX-drag.x)*0.004);
    observer.pitch=P.clamp(observer.pitch-(e.clientY-drag.y)*0.003,-0.85,0.5);
    drag.x=e.clientX;drag.y=e.clientY;
  });
  for(const event of ['pointerup','pointercancel','lostpointercapture'])viewport.addEventListener(event,()=>{drag=null;});
  document.querySelectorAll('[data-surf-move]').forEach(button=>{
    button.addEventListener('pointerdown',e=>{
      e.preventDefault();e.stopPropagation();unlockAudio();const action=button.dataset.surfMove;
      if(action==='turnLeft'||action==='turnRight')turn((action==='turnLeft'?-1:1)*Math.PI/12);
      else held.add(action);
      button.setPointerCapture(e.pointerId);
    });
    for(const event of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(event,()=>held.delete(button.dataset.surfMove));
    button.addEventListener('click',e=>{
      if(e.detail!==0)return;
      const action=button.dataset.surfMove;
      if(action==='turnLeft'||action==='turnRight')turn((action==='turnLeft'?-1:1)*Math.PI/12);
      else if(!paused){held.add(action);walk(0.2);held.delete(action);}
    });
  });
  $('surf-reset').addEventListener('click',()=>{
    Object.assign(observer,{x:0,z:8,y:2.38,yaw:0,pitch:-0.065});viewport.focus({preventScroll:true});
  });
  function togglePause() {
    paused=!paused;held.clear();lastFrame=performance.now();accumulator=0;
    for(const id of ['surf-pause','surf-pause-overlay']) {
      $(id).textContent=paused?'Resume simulation':'Pause simulation';
      $(id).setAttribute('aria-pressed',String(paused));
    }
    viewport.classList.toggle('is-paused',paused);
    if(paused)audio.pause();else { viewport.focus({preventScroll:true});unlockAudio(); }
  }
  $('surf-pause').addEventListener('click',togglePause);
  $('surf-pause-overlay').addEventListener('click',togglePause);
  $('surf-mute').addEventListener('click',()=>{
    audio.muted=!audio.muted;audio.setVolume(audio.volume);
    $('surf-mute').textContent=audio.muted?'Unmute':'Mute';$('surf-mute').setAttribute('aria-pressed',String(audio.muted));
  });
  $('surf-fullscreen').addEventListener('click',async()=>{
    try { if(document.fullscreenElement)await document.exitFullscreen();else await viewport.requestFullscreen(); }
    catch {message('Full screen is unavailable here. You can still drag the view and walk using the controls.');}
  });
  $('surf-exit-fullscreen').addEventListener('click',()=>document.exitFullscreen().catch(()=>{}));
  for(const name of ['wind','fetch','volume'])$('surf-'+name).addEventListener('input',e=>{
    const n=Number(e.target.value);
    if(name==='wind') {if(world)world.wind=n;$('surf-wind-value').textContent=`${n} m/s`;}
    if(name==='fetch'){if(world)world.fetchKm=n;$('surf-fetch-value').textContent=`${n} km`;}
    if(name==='volume'){audio.setVolume(n/100);$('surf-volume-value').textContent=`${n}%`;}
  });

  function updateUI() {
    const stats=world.stats(), d=audio.diagnostics();
    $('surf-height').textContent=`${stats.height.toFixed(2)} m`;
    $('surf-period').textContent=`${stats.period.toFixed(2)} s`;
    $('surf-gust-value').textContent=stats.wind<0.01?'Calm · no wind input':`Now ${stats.wind.toFixed(1)} m/s · ${stats.windAngle>=0?'+':''}${stats.windAngle.toFixed(1)}°`;
    $('surf-observer').textContent=`${observer.x.toFixed(1)} m along beach · ${observer.z.toFixed(1)} m inland · ${Math.round(observer.yaw*180/Math.PI)}°`;
    $('surf-events').textContent=paused?'Simulation paused':`${stats.breaking} breaking · ${stats.water.uprush} uprush / ${stats.water.backwash} backwash cells`;
    const status=paused?'Paused':audio.muted?'Sound muted':d.state==='running'?'Synthesized surf · stereo': 'Tap the view for sound';
    if($('surf-audio-status').textContent!==status)$('surf-audio-status').textContent=status;
    document.querySelector('.surf-horizon-label span:last-child').style.transform=`rotate(${-world.gust.angle-observer.yaw}rad)`;
    $('surf-left-meter').value=P.clamp(d.earPeaks[0]*3,0,1);
    $('surf-right-meter').value=P.clamp(d.earPeaks[1]*3,0,1);
    const paths=d.paths;
    const source=audio.audibleSources()[0];
    $('surf-distance').textContent=paths?`Strongest ${source?.kind==='wash'?'wash':'break'} · ${paths[0].distance.toFixed(1)} m · L ${(paths[0].delay*1000).toFixed(1)} / R ${(paths[1].delay*1000).toFixed(1)} ms`:'Direct sound paths from the surf';
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if(!active||!initialized||failed||document.hidden) {lastFrame=now;return;}
    const dt=Math.min(0.1,Math.max(0,(now-lastFrame)/1000));lastFrame=now;
    fps=P.mix(fps,1/Math.max(0.001,dt),0.03);
    if(!paused) {
      accumulator+=dt;walk(dt);
      while(accumulator>=1/60) {world.step(1/60);accumulator-=1/60;}
      const events=world.takeEvents();
      for(const event of events){if(event.kind!=='wash')splash(event);audio.emit(event,observer,world.gust.vector);}
      updateSpray(dt);audio.update(observer,world.gust.vector,world.swash);
    }
    camera.position.set(observer.x,observer.y,observer.z);
    camera.rotation.set(observer.pitch, -observer.yaw,0,'YXZ');
    water.material.uniforms.time.value=world.time;water.material.uniforms.wind.value=world.gust.speed;
    water.material.uniforms.windVector.value.set(world.windOffset.x,world.windOffset.z);
    sky.material.uniforms.time.value=world.time;
    sand.material.uniforms.wet.value=Array.from(world.wetReach);
    drawShore();
    for(const front of world.fronts){
      if(!visuals.has(front.id))visuals.set(front.id,ribbon(front));
      drawFront(front,visuals.get(front.id));
    }
    for(const [id,v] of visuals)if(!world.fronts.some(f=>f.id===id)) {
      scene.remove(v.mesh);v.mesh.geometry.dispose();v.mesh.material.dispose();
      visuals.delete(id);
    }
    renderer.render(scene,camera);
    uiClock+=dt;if(uiClock>0.2){updateUI();uiClock=0;}
  }
  requestAnimationFrame(frame);
  window.Surf3D={setActive,observer,audio,
    diagnostics:()=>({active,paused,failed,initialized,fps,observer:{...observer},
      physics:world?.stats(),audio:audio.diagnostics(),meshes:visuals.size,particles:particles.length,
      soundOrigins:soundMarkers.filter(marker=>marker.visible).length,
      triangles:renderer?.info.render.triangles}),
    get ocean(){return world;}};
})();
