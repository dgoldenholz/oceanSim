(function () {
  'use strict';
  const template = document.getElementById('surf-page-template');
  document.querySelector('.app-shell').appendChild(template.content.cloneNode(true));
  const P = window.SurfPhysics;
  const $ = id => document.getElementById(id);
  const viewport = $('surf-viewport');
  const audio = new window.SurfAudio();
  let world, scene, camera, renderer, water, sand, sky, spray;
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
    varying vec3 worldPosition; varying vec3 waterNormal; varying float foamAmount;
    uniform float time; uniform float wind; uniform float sheet; ${NOISE}
    void main() {
      vec3 p=worldPosition;
      float dist=length(cameraPosition-p);
      vec2 uv=p.xz*1.2+vec2(time*0.06,-time*0.55);
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
      float foam=smoothstep(0.08,0.80,foamAmount)*(0.20+0.80*lace);
      col=mix(col,vec3(0.79,0.85,0.79),foam);
      col=mix(col,vec3(0.65,0.78,0.79),1.0-exp(-dist*0.0025));
      gl_FragColor=vec4(col,mix(1.0,0.55+0.4*foam,sheet));
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
      uniforms: { wet: { value: wet } },
      fragmentShader: `varying vec3 worldPosition; uniform float wet[41]; ${NOISE}
      void main() {
        vec3 p=worldPosition;
        int idx=int(clamp(floor((p.x+80.0)/4.0),0.0,40.0));
        float wetEdge=wet[idx];
        float damp=1.0-smoothstep(wetEdge,wetEdge+1.2,p.z);
        float grain=noise(p.xz*105.0)*0.09+noise(p.xz*24.0)*0.07;
        float ridges=sin(p.x*23.0+sin(p.z*1.7)*0.6)*0.012;
        vec3 dry=vec3(0.68,0.56,0.37)+grain+ridges;
        vec3 moist=vec3(0.38,0.33,0.23)+grain*0.6;
        vec3 col=mix(dry,moist,damp*0.78);
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
      uniforms: { time: { value: 0 }, wind: { value: 12 }, sheet: { value: 0 } },
      vertexShader: `varying vec3 worldPosition; varying vec3 waterNormal; varying float foamAmount;
        uniform float time; uniform float wind;
        void main() {
          vec3 p=position;
          float shallow=smoothstep(0.0,8.0,-p.z);
          p.y+=shallow*wind*0.002*(sin(p.x*0.65+p.z*1.2-time*2.9)+sin(p.x*1.7-p.z*0.9+time*3.2));
          worldPosition=p;
          waterNormal=vec3(0,1,0);foamAmount=0.0;
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
      uniforms: { time:{value:0},wind:{value:12},sheet:{value:0} }, fragmentShader:WATER_FRAGMENT,
      vertexShader:`varying vec3 worldPosition; varying vec3 waterNormal; varying float foamAmount;
        void main() {
          worldPosition=position;waterNormal=normal;foamAmount=color.r;
          gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
        }` });
    const mesh=new THREE.Mesh(geometry,material); mesh.frustumCulled=false; scene.add(mesh);
    const swashGeometry=new THREE.BufferGeometry();
    swashGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rows*5*3),3).setUsage(THREE.DynamicDrawUsage));
    swashGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(rows*5*3),3).setUsage(THREE.DynamicDrawUsage));
    const si=[];
    for(let i=0;i<rows-1;i++) for(let j=0;j<4;j++) { const k=i*5+j; si.push(k,k+5,k+1,k+1,k+5,k+6); }
    swashGeometry.setIndex(si);
    const swashMaterial=material.clone();
    swashMaterial.uniforms.sheet.value=1;
    swashMaterial.transparent=true;swashMaterial.depthWrite=false;
    const swash=new THREE.Mesh(swashGeometry,swashMaterial); swash.frustumCulled=false; swash.renderOrder=2; scene.add(swash);
    return { mesh, swash, cols };
  }

  function drawFront(front, visual) {
    const positions=visual.mesh.geometry.attributes.position;
    const colors=visual.mesh.geometry.attributes.color;
    const sp=visual.swash.geometry.attributes.position, sc=visual.swash.geometry.attributes.color;
    visual.mesh.material.uniforms.time.value=world.time;
    visual.mesh.material.uniforms.wind.value=world.wind;
    visual.swash.material.uniforms.time.value=world.time;
    visual.swash.material.uniforms.wind.value=world.wind;
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
        if(s.runup||s.z<-120) y=-0.07;
        positions.setXYZ(i*visual.cols+j,s.x,y,z);
        colors.setXYZ(i*visual.cols+j,foam,foam,foam);
      }
      const run=s.runup;
      for(let j=0;j<5;j++) {
        const q=j/4;
        let z=-2.7, y=-0.04;
        if(run&&!run.done) {
          z=P.mix(-3,run.z,q);
          const thickness=run.volume/Math.max(3,run.z+3)*0.22;
          y=Math.max(-0.015,P.bedHeight(s.x,z))+Math.max(0.012,thickness*(1-q))*s.foam+0.012;
        }
        sp.setXYZ(i*5+j,s.x,y,z);
        const foam=j===4 ? 0.98 : 0.20;
        sc.setXYZ(i*5+j,foam,foam,foam);
      }
    }
    positions.needsUpdate=colors.needsUpdate=sp.needsUpdate=sc.needsUpdate=true;
    visual.mesh.geometry.computeVertexNormals(); visual.swash.geometry.computeVertexNormals();
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
      p.vz+=(world.wind*0.35-p.vz)*dt*0.4; p.vy-=P.G*dt;
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
      world=new P.Ocean();makeSky();makeSand();makeWater();makeSpray();
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
  $('surf-pause').addEventListener('click',()=>{
    paused=!paused;held.clear();$('surf-pause').textContent=paused?'Resume':'Pause';
    $('surf-pause').setAttribute('aria-pressed',String(paused));
    if(paused)audio.silence();else unlockAudio();
  });
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
    $('surf-observer').textContent=`${observer.x.toFixed(1)} m along beach · ${observer.z.toFixed(1)} m inland · ${Math.round(observer.yaw*180/Math.PI)}°`;
    $('surf-events').textContent=paused?'Simulation paused':`${stats.breaking} sections breaking · ${stats.swash} sections washing ashore`;
    const status=paused?'Paused':audio.muted?'Sound muted':d.state==='running'?'Synthesized surf · stereo': 'Tap the view for sound';
    if($('surf-audio-status').textContent!==status)$('surf-audio-status').textContent=status;
    document.querySelector('.surf-horizon-label span:last-child').style.transform=`rotate(${-observer.yaw}rad)`;
    $('surf-left-meter').value=P.clamp(d.earPeaks[0]*3,0,1);
    $('surf-right-meter').value=P.clamp(d.earPeaks[1]*3,0,1);
    const paths=d.paths;
    $('surf-distance').textContent=paths?`Last break · L ${(paths[0].delay*1000).toFixed(1)} ms · R ${(paths[1].delay*1000).toFixed(1)} ms`:'Direct sound paths from the surf';
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
      for(const event of events){splash(event);audio.emit(event,observer,world.wind);}
      updateSpray(dt);audio.update(observer,world.wind);
    }
    camera.position.set(observer.x,observer.y,observer.z);
    camera.rotation.set(observer.pitch, -observer.yaw,0,'YXZ');
    water.material.uniforms.time.value=world.time;water.material.uniforms.wind.value=world.wind;
    sky.material.uniforms.time.value=world.time;
    sand.material.uniforms.wet.value=Array.from(world.wetReach);
    for(const front of world.fronts){
      if(!visuals.has(front.id))visuals.set(front.id,ribbon(front));
      drawFront(front,visuals.get(front.id));
    }
    for(const [id,v] of visuals)if(!world.fronts.some(f=>f.id===id)) {
      for(const mesh of [v.mesh,v.swash]){scene.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();}
      visuals.delete(id);
    }
    renderer.render(scene,camera);
    uiClock+=dt;if(uiClock>0.2){updateUI();uiClock=0;}
  }
  requestAnimationFrame(frame);
  window.Surf3D={setActive,observer,audio,
    diagnostics:()=>({active,paused,failed,initialized,fps,observer:{...observer},
      physics:world?.stats(),audio:audio.diagnostics(),meshes:visuals.size,particles:particles.length,
      triangles:renderer?.info.render.triangles}),
    get ocean(){return world;}};
})();
