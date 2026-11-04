'use strict';

const $ = (id) => document.getElementById(id);
const files = [];

let selected = null,
    request = 0,
    model = null,
    engine = null,
    highlighted = null;
let highlightedGroup = null;
let tool = 'select',
    pendingPoint = null,
    pendingMarker = null,
    isolated = false;
const measurements = [];
const tabNames = {
    view: 'Вид и навигация',
    parts: 'Выбранная деталь',
    tree: 'Структура модели',
    search: 'Поиск по позициям',
    measure: 'Измерения',
    materials: 'Материалы',
    files: 'Модель и файлы',
    render: 'Настройки рендера'
};
let activeTab = 'view',
    hoverGraphic = null;
let heldSnap = null;
let materialEditor = 'color',
    ledBaker = null,
    choosingLightFace = false;
let savedColorScope = null,
    fpsFrames = 0,
    fpsPending = false,
    fpsSince = performance.now();
window.setInterval(() => {
    const now = performance.now();
    $('viewer-fps').textContent = document.hidden
        ? '- FPS'
        : Math.round((fpsFrames * 1000) / Math.max(1, now - fpsSince)) + ' FPS';
    fpsFrames = 0;
    fpsSince = now;
}, 1000);
const defaultLight = { color: '#fff1d6', power: 1, distance: 1200 };

let contextPart = null;

const textureAssets = new Map();
let textureOperation = 0;

const sectionTools = window.createSectionTools({ getEngine: () => engine, getModel: () => model, render });
const treeTools = window.createModelTree({
    getModel: () => model,
    getSelection: () => highlightedGroup?.id || highlighted?.userData.treeNodeId || null,
    selectPart,
    selectGroup: selectTreeGroup,
    focus: focusTreeParts,
    visibilityChanged: treeVisibilityChanged
});
const snapNames = {
    vertex: 'Угол / вершина',
    midpoint: 'Середина ребра',
    edge: 'Точка на ребре',
    center: 'Центр плоскости',
    plane: 'Перпендикуляр к плоскости',
    surface: 'Поверхность'
};
const swatches = ['#ffffff', '#dce0df', '#beb9ac', '#d1b48c', '#8e6243', '#453b33', '#303640', '#15191f'];
const mm = (n) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n);
const dimensionText = (values) => values.map(mm).join(' × ');
const sizeLabel = (bytes) => new Intl.NumberFormat('ru', { maximumFractionDigits: 1 }).format(bytes / 1024) + ' КБ';
const renderDefaults = {
    quality: 1,
    mode: 'solid',
    flat: false,
    ambient: 1.1,
    key: 0.85,
    fill: 0.3,
    angle: 40,
    tone: 'none',
    exposure: 1,
    shadows: false,
    shadowQuality: 1024,
    roughness: 0.8,
    background: '#ffffff',
    fov: 38
};
const renderPresets = {
    fast: { ...renderDefaults, quality: 0.75, shadowQuality: 512 },
    balanced: { ...renderDefaults },
    studio: {
        ...renderDefaults,
        quality: 2,
        ambient: 0.7,
        key: 1.5,
        fill: 0.5,
        tone: 'aces',
        exposure: 1.15,
        shadows: true,
        shadowQuality: 2048,
        roughness: 0.65
    }
};
let renderSettings = { ...renderDefaults };
function normalizeRenderSettings(value) {
    const result = { ...renderDefaults };
    if (!value || typeof value !== 'object') return result;
    const ranges = {
        ambient: [0, 2],
        key: [0, 3],
        fill: [0, 2],
        angle: [0, 360],
        exposure: [0.3, 2],
        roughness: [0.05, 1],
        fov: [20, 75]
    };
    for (const [key, range] of Object.entries(ranges))
        if (typeof value[key] === 'number' && Number.isFinite(value[key]))
            result[key] = Math.max(range[0], Math.min(range[1], value[key]));
    for (const [key, values] of Object.entries({
        quality: [0.75, 1, 1.5, 2],
        shadowQuality: [512, 1024, 2048],
        mode: ['solid', 'wireframe'],
        tone: ['none', 'aces', 'reinhard']
    }))
        if (values.includes(value[key])) result[key] = value[key];
    for (const key of ['flat', 'shadows']) if (typeof value[key] === 'boolean') result[key] = value[key];
    if (typeof value.background === 'string' && /^#[0-9a-f]{6}$/i.test(value.background))
        result.background = value.background;
    return result;
}
function syncRenderControls() {
    for (const key of Object.keys(renderDefaults)) {
        const id = key === 'shadowQuality' ? 'shadow-quality' : key;
        const field = $('render-' + id);
        if (typeof renderDefaults[key] === 'boolean') field.checked = renderSettings[key];
        else field.value = String(renderSettings[key]);
    }
    for (const key of ['ambient', 'key', 'fill', 'angle', 'exposure', 'roughness', 'fov'])
        $('render-' + key + '-value').textContent =
            mm(renderSettings[key]) + (key === 'angle' || key === 'fov' ? '°' : '');
    $('render-exposure').disabled = renderSettings.tone === 'none';
    $('render-shadow-quality').disabled = !renderSettings.shadows;
    for (const [name, preset] of Object.entries(renderPresets))
        $('render-' + name).setAttribute(
            'aria-pressed',
            String(Object.keys(renderDefaults).every((key) => preset[key] === renderSettings[key]))
        );
}
function applyRenderSettings() {
    syncRenderControls();
    $('canvas').style.background = renderSettings.background;
    if (!engine) return;
    const { renderer, camera, scene, ambient, light, fill } = engine;
    const previous = engine.appliedRenderSettings || {};
    if (previous.quality !== renderSettings.quality) renderer.setPixelRatio(renderSettings.quality);
    const width = $('canvas').clientWidth,
        height = $('canvas').clientHeight;
    renderer.setSize(width, height);
    camera.aspect = width / Math.max(1, height);
    camera.fov = renderSettings.fov;
    camera.updateProjectionMatrix();
    renderer.toneMapping = {
        none: THREE.NoToneMapping,
        aces: THREE.ACESFilmicToneMapping,
        reinhard: THREE.ReinhardToneMapping
    }[renderSettings.tone];
    renderer.toneMappingExposure = renderSettings.exposure;
    renderer.shadowMap.enabled = renderSettings.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    ambient.intensity = renderSettings.ambient;
    light.intensity = renderSettings.key;
    fill.intensity = renderSettings.fill;
    light.castShadow = renderSettings.shadows && renderSettings.mode === 'solid';
    const shadowSize = Math.min(renderSettings.shadowQuality, renderer.capabilities.maxTextureSize);
    if (light.shadow.mapSize.x !== shadowSize || !renderSettings.shadows) {
        light.shadow.mapSize.set(shadowSize, shadowSize);
        if (light.shadow.map) {
            light.shadow.map.dispose();
            light.shadow.map = null;
        }
    }
    if (model) {
        const center = model.bounds.getCenter(new THREE.Vector3()),
            size = model.bounds.getSize(new THREE.Vector3()),
            radius = Math.max(1, size.length() / 2);
        const angle = (renderSettings.angle * Math.PI) / 180;
        light.position.set(
            center.x + Math.sin(angle) * radius * 2,
            center.y + radius * 3,
            center.z + Math.cos(angle) * radius * 2
        );
        light.target.position.copy(center);
        fill.position.copy(center).add(new THREE.Vector3(-radius * 2, radius, -radius));
        const shadowCamera = light.shadow.camera;
        shadowCamera.left = shadowCamera.bottom = -radius * 1.5;
        shadowCamera.right = shadowCamera.top = radius * 1.5;
        const lightDistance = light.position.distanceTo(center);
        shadowCamera.near = Math.max(0.1, lightDistance - radius * 1.75);
        shadowCamera.far = lightDistance + radius * 2;
        shadowCamera.updateProjectionMatrix();

        const shadowTexel = (radius * 3) / shadowSize;
        light.shadow.bias = -0.0003;
        light.shadow.normalBias = Math.min(2, Math.max(0.05, shadowTexel * 0.15));
        if (renderSettings.shadows && !engine.shadowFloor) {
            engine.shadowFloor = new THREE.Mesh(
                new THREE.PlaneGeometry(1, 1),
                new THREE.ShadowMaterial({ opacity: 0.2, depthWrite: false })
            );
            engine.shadowFloor.rotation.x = -Math.PI / 2;
            engine.shadowFloor.receiveShadow = true;
            scene.add(engine.shadowFloor);
        }
        if (engine.shadowFloor) {
            engine.shadowFloor.position.set(center.x, model.bounds.min.y - 0.5, center.z);
            engine.shadowFloor.scale.set(radius * 5, radius * 5, 1);
            engine.shadowFloor.visible = renderSettings.shadows && renderSettings.mode === 'solid';
        }
        for (const panel of model.panels) {
            panel.material.wireframe = renderSettings.mode === 'wireframe';
            panel.material.flatShading = renderSettings.flat;
            panel.material.roughness = renderSettings.roughness;
            if (
                ['mode', 'flat', 'tone', 'shadows'].some((key) => previous[key] !== renderSettings[key]) ||
                engine.appliedModel !== model
            )
                panel.material.needsUpdate = true;
            panel.receiveShadow = renderSettings.shadows;
            panel.castShadow = renderSettings.shadows && !panel.material.transparent;
        }
    }
    engine.appliedRenderSettings = { ...renderSettings };
    engine.appliedModel = model;
    scene.updateMatrixWorld(true);
    render();
}
function initializeViewCube() {
    const cube = $('view-cube');
    const faces = [
        ['front', 'Спереди', [0, 0, 1]],
        ['back', 'Сзади', [0, 0, -1]],
        ['right', 'Справа', [1, 0, 0]],
        ['left', 'Слева', [-1, 0, 0]],
        ['top', 'Сверху', [0, 1, 0]],
        ['bottom', 'Снизу', [0, -1, 0]]
    ];
    function navigate(direction) {
        if (!model) return;
        const vector = new THREE.Vector3(...direction);
        if (!vector.x && !vector.z) vector.z = 0.0001;
        fit(vector.normalize());
    }
    for (const [face, label, direction] of faces) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cube-face cube-' + face;
        button.textContent = label;
        button.title = label;
        button.setAttribute('aria-label', 'Вид ' + label.toLocaleLowerCase());
        button.onclick = () => navigate(direction);
        cube.append(button);
    }
    for (const x of [-1, 1])
        for (const y of [-1, 1])
            for (const z of [-1, 1]) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'cube-corner';
                const label =
                    'Объёмный вид: ' +
                    (y > 0 ? 'сверху' : 'снизу') +
                    ', ' +
                    (x > 0 ? 'справа' : 'слева') +
                    ', ' +
                    (z > 0 ? 'спереди' : 'сзади');
                button.title = label;
                button.setAttribute('aria-label', label);
                button.style.transform = `translate3d(${x * 38}px,${-y * 38}px,${z * 38}px)`;
                button.onclick = () => navigate([x, y, z]);
                cube.append(button);
            }
    updateViewCube();
}
function updateViewCube() {
    if (!window.THREE) return;
    const rotation = engine
        ? engine.camera.quaternion.clone()
        : new THREE.Quaternion().setFromRotationMatrix(
              new THREE.Matrix4().lookAt(
                  new THREE.Vector3(1, 0.65, 1.8),
                  new THREE.Vector3(),
                  new THREE.Vector3(0, 1, 0)
              )
          );
    const matrix = new THREE.Matrix4().makeRotationFromQuaternion(rotation.invert());

    const signs = [1, -1, 1, 1];
    const values = matrix.elements.map((value, index) => value * signs[index % 4] * signs[Math.floor(index / 4)]);
    $('view-cube').style.transform = 'matrix3d(' + values.join(',') + ')';
}
function updateCameraProjection() {
    const camera = engine.camera;
    camera.aspect = Math.max(1, $('canvas').clientWidth) / Math.max(1, $('canvas').clientHeight);
    camera.fov = renderSettings.fov;
    if (camera.isOrthographicCamera) {
        const halfHeight =
            Math.max(0.01, camera.position.distanceTo(engine.controls.target)) * Math.tan((camera.fov * Math.PI) / 360);
        camera.top = halfHeight;
        camera.bottom = -halfHeight;
        camera.right = halfHeight * camera.aspect;
        camera.left = -camera.right;
    }
    camera.updateProjectionMatrix();
}
function setPerspective(enabled) {
    $('perspective').checked = enabled;
    if (!engine || Boolean(engine.camera.isPerspectiveCamera) === enabled) return;
    const previous = engine.camera;
    const camera = enabled
        ? new THREE.PerspectiveCamera(renderSettings.fov, previous.aspect, previous.near, previous.far)
        : new THREE.OrthographicCamera(-1, 1, 1, -1, previous.near, previous.far);
    camera.position.copy(previous.position);
    camera.quaternion.copy(previous.quaternion);
    camera.up.copy(previous.up);
    if (enabled) camera.position.sub(engine.controls.target).divideScalar(previous.zoom).add(engine.controls.target);
    engine.camera = camera;
    engine.controls.object = camera;
    updateCameraProjection();
    engine.controls.update();
    clearHover();
    render();
}
function initialize3D() {
    if (engine) return engine;
    if (
        !window.THREE ||
        !THREE.OrbitControls ||
        !window.pako ||
        !window.BazisB3D ||
        !window.BazisScene ||
        !window.BazisCuts ||
        !window.BazisHardware
    )
        throw new Error(
            'Не загрузились JS-файлы. Скопируйте папку vendor, b3d-parser.js, b3d-cuts.js, b3d-hardware.js и b3d-scene.js.'
        );
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.domElement.className = 'webgl-view';
    $('canvas').prepend(renderer.domElement);
    const scene = new THREE.Scene(),
        camera = new THREE.PerspectiveCamera(38, 1, 1, 100000);
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.screenSpacePanning = true;
    const ambient = new THREE.HemisphereLight(0xffffff, 0x727c8a, 1.1);
    scene.add(ambient);
    const light = new THREE.DirectionalLight(0xffffff, 0.85);
    light.position.set(2000, 3500, 4000);
    scene.add(light);
    const fill = new THREE.DirectionalLight(0xb9d5ff, 0.3);
    fill.position.set(-2500, 1000, -1000);
    scene.add(fill);
    scene.add(light.target);
    engine = {
        renderer,
        scene,
        camera,
        controls,
        ambient,
        light,
        fill,
        baseDistance: 1,
        grid: null,
        selectionBox: null,
        shadowFloor: null
    };
    controls.addEventListener('change', () => {
        closePartMenu();
        clearHover();
        render();
    });
    const resize = () => {
        const w = $('canvas').clientWidth,
            h = $('canvas').clientHeight;
        renderer.setSize(w, h);
        updateCameraProjection();
        render();
    };
    resize();
    new ResizeObserver(resize).observe($('canvas'));
    applyRenderSettings();
    installPointerInteractions(renderer.domElement, controls);
    setPerspective($('perspective').checked);
    return engine;
}
function installPointerInteractions(element, controls) {
    const pointers = new Set();
    let down = null,
        timer = null;
    const stopTimer = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };
    element.addEventListener('pointerdown', (event) => {
        stopTimer();
        pointers.add(event.pointerId);
        if (pointers.size > 1) {
            if (down) down.moved = true;
            clearHover();
            return;
        }
        down = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            button: event.button,
            touch: event.pointerType === 'touch',
            moved: false,
            held: false
        };
        try {
            element.setPointerCapture(event.pointerId);
        } catch (_) {}
        if (down.touch && tool === 'select')
            timer = setTimeout(() => {
                if (!down || down.moved || pointers.size !== 1) return;
                const hit = pick(event);
                if (hit) {
                    down.held = true;
                    openPartMenu(hit.object, event);
                    controls.enabled = false;
                }
            }, 550);
    });
    element.addEventListener('pointermove', (event) => {
        if (
            down &&
            event.pointerId === down.id &&
            Math.hypot(event.clientX - down.x, event.clientY - down.y) > (down.touch ? 8 : 4)
        ) {
            down.moved = true;
            stopTimer();
        }
        if (pointers.size || tool !== 'measure' || !model || event.buttons) {
            if (hoverGraphic) {
                clearHover();
                render();
            }
            return;
        }
        const hit = pick(event);
        if (!hit) {
            if (hoverGraphic) {
                clearHover();
                render();
            }
            $('snap-status').textContent = 'Наведите курсор на поверхность детали';
            return;
        }
        showSnapPreview(snapPoint(hit, event), event);
    });
    element.addEventListener('pointerup', (event) => {
        stopTimer();
        pointers.delete(event.pointerId);
        controls.enabled = true;
        const gesture = down;
        if (!pointers.size) down = null;
        if (
            !gesture ||
            gesture.id !== event.pointerId ||
            gesture.moved ||
            gesture.held ||
            pointers.size ||
            Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > (gesture.touch ? 8 : 4)
        )
            return;
        const hit = pick(event);
        if (gesture.button === 2) {
            openPartMenu(hit ? hit.object : null, event);
            return;
        }
        if (!model) return;
        if (gesture.button !== 0) return;
        if (choosingLightFace) {
            if (!hit) return;
            if (hit.object !== highlighted) {
                $('light-status').textContent = 'Нажмите на грань выбранной детали.';
                return;
            }
            const normal = hit.face.normal.clone();
            if (hit.object.userData.localMatrix)
                normal.transformDirection(hit.object.userData.localMatrix.clone().invert());
            for (const panel of lightTargets()) {
                panel.userData.light = { ...defaultLight, ...panel.userData.light, face: normal.toArray() };
                panel.userData.glow = true;
            }
            choosingLightFace = false;
            $('canvas').classList.remove('choosing-light-face');
            updateColorControls();
            render();
            return;
        }
        if (tool === 'measure') {
            if (hit) addMeasurementPoint(snapPoint(hit, event));
            else $('snap-status').textContent = 'Нажмите на поверхность детали.';
        } else {
            selectPart(hit ? hit.object : null, event.shiftKey);
            if (hit && !['materials', 'render', 'tree'].includes(activeTab)) openTab('parts');
        }
    });
    element.addEventListener('pointercancel', (event) => {
        stopTimer();
        pointers.delete(event.pointerId);
        if (down) down.moved = true;
        if (!pointers.size) down = null;
        controls.enabled = true;
    });
    element.addEventListener('contextmenu', (event) => event.preventDefault());
    element.addEventListener('pointerleave', () => {
        if (!pointers.size) {
            clearHover();
            render();
        }
    });
}
let renderPending = false;
let contactModel = null,
    contactPart = null,
    contactContours = new Set();
function updateSelectionHardware() {
    if (!model) return;
    const part =
        $('selection-hardware').checked && highlighted && !highlighted.userData.isHardware ? highlighted : null;
    if (model !== contactModel || part !== contactPart) {
        contactModel = model;
        contactPart = part;
        contactContours = new Set();
        if (part) {
            const inverse = part.userData.localMatrix.clone().invert();
            const localGeometry = part.geometry.clone().applyMatrix4(inverse);
            localGeometry.computeBoundingBox();
            const bounds = localGeometry.boundingBox.clone().expandByScalar(0.3);
            localGeometry.dispose();
            const ray = new THREE.Ray(),
                hit = new THREE.Vector3();
            for (const contour of model.hardware.children) {
                const positions = contour.geometry?.attributes.position;
                if (!positions) continue;
                for (let i = 0; i + 1 < positions.count; i += 2) {
                    const a = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(inverse);
                    const b = new THREE.Vector3().fromBufferAttribute(positions, i + 1).applyMatrix4(inverse);
                    if (bounds.containsPoint(a) || bounds.containsPoint(b)) {
                        contactContours.add(contour);
                        break;
                    }
                    const direction = b.clone().sub(a),
                        length = direction.length();
                    if (!length) continue;
                    ray.set(a, direction.divideScalar(length));
                    if (ray.intersectBox(bounds, hit) && hit.distanceTo(a) <= length) {
                        contactContours.add(contour);
                        break;
                    }
                }
            }
        }
    }
    const showAllContours = $('hardware').checked && !isolated;
    let visible = false;
    for (const contour of model.hardware.children) {
        contour.visible = showAllContours || contactContours.has(contour);
        visible ||= contour.visible;
    }
    model.hardware.visible = visible;
}
function render() {
    if (!engine || renderPending) return;
    renderPending = true;
    window.requestAnimationFrame(() => {
        renderPending = false;
        renderFrame();
    });
}
function renderFrame() {
    if (!engine) return;
    updateSelectionHardware();
    updateCameraProjection();
    updateViewCube();
    if (model) for (const panel of model.panels) updateMaterialGlow(panel);
    updateLEDLights();
    if (model) {
        const radius = Math.max(1, model.bounds.getSize(new THREE.Vector3()).length() / 2);
        const distance = engine.camera.position.distanceTo(model.bounds.getCenter(new THREE.Vector3()));
        const focusDistance = engine.camera.position.distanceTo(engine.controls.target);
        const near = Math.max(0.1, Math.min(focusDistance * 0.005, radius * 0.005));
        const far = Math.max(near * 10, distance + radius * (renderSettings.shadows ? 5 : 2.5));
        if (engine.camera.near !== near || engine.camera.far !== far) {
            engine.camera.near = near;
            engine.camera.far = far;
            engine.camera.updateProjectionMatrix();
        }
    }
    if (engine.renderer.info) {
        const stats = engine.renderer.info.render,
            pixels = engine.renderer.getDrawingBufferSize(new THREE.Vector2());
        $('render-info').textContent =
            'WebGL ' +
            (engine.renderer.capabilities.isWebGL2 ? '2' : '1') +
            ' · ' +
            pixels.x +
            ' × ' +
            pixels.y +
            ' px · ' +
            stats.calls +
            ' вызовов · ' +
            new Intl.NumberFormat('ru-RU').format(stats.triangles) +
            ' треугольников';
    }
    if (model)
        $('zoom').textContent =
            Math.round(
                (engine.baseDistance / engine.camera.position.distanceTo(engine.controls.target)) *
                    engine.camera.zoom *
                    100
            ) + '%';

    engine.camera.updateMatrixWorld(true);
    for (const measurement of measurements) {
        const point = measurement.a.clone().add(measurement.b).multiplyScalar(0.5).project(engine.camera);
        measurement.label.hidden = point.z < -1 || point.z > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1;
        measurement.label.style.left = ((point.x + 1) / 2) * $('canvas').clientWidth + 'px';
        measurement.label.style.top = ((1 - point.y) / 2) * $('canvas').clientHeight + 'px';
        const distance = engine.camera.position.distanceTo(engine.controls.target);
        const scale = Math.max(0.55, Math.min(1.3, (engine.baseDistance * engine.camera.zoom) / Math.max(1, distance)));
        measurement.label.style.transform = 'translate(-50%,-50%) scale(' + scale + ')';
        measurement.graphic.traverse((object) => {
            if (object.isPoints) object.material.size = 6 * scale;
        });
    }
    sectionTools.render();
    treeTools.sync();
    $('header-show-all').disabled = !model || !model.panels.some((panel) => !panel.visible);
    $('header-focus').disabled = !model || (!highlighted && !highlightedGroup);
    engine.renderer.render(engine.scene, engine.camera);
    if (!fpsPending) {
        fpsPending = true;
        window.requestAnimationFrame(() => {
            fpsFrames++;
            fpsPending = false;
        });
    }
}
function disposeObject(object) {
    if (!object || !engine) return;
    engine.scene.remove(object);
    object.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
    });
}
function pick(event) {
    if (!model) return null;
    const rect = engine.renderer.domElement.getBoundingClientRect(),
        ray = new THREE.Raycaster();
    ray.setFromCamera(
        new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            (-(event.clientY - rect.top) / rect.height) * 2 + 1
        ),
        engine.camera
    );
    return (
        ray
            .intersectObjects(model.panels.filter((panel) => panel.visible))
            .find((hit) => sectionTools.isVisible(hit.point)) || null
    );
}
function closePartMenu() {
    $('part-menu').hidden = true;
    contextPart = null;
}
function openPartMenu(part, event) {
    if (!part || !highlightedGroup?.parts.has(part)) selectPart(part);
    contextPart = part;
    for (const id of ['hide-part', 'context-isolate', 'context-focus']) $(id).disabled = !part;
    $('context-drawing').disabled = !part || Boolean(part.userData.isHardware) || highlightedGroup?.parts.size > 1;
    $('context-show-all').disabled = !model || !model.panels.some((panel) => !panel.visible);
    const menu = $('part-menu');
    menu.hidden = false;
    const rect = $('app').getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(event.clientX - rect.left, rect.width - menu.offsetWidth - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(event.clientY - rect.top, rect.height - menu.offsetHeight - 4)) + 'px';
}
function hidePart(part) {
    closePartMenu();
    if (!model || !part || !model.panels.includes(part)) return;
    part.visible = false;
    if (highlighted === part) selectPart(null);
    isolated = false;
    $('isolate-part').setAttribute('aria-pressed', 'false');
    $('show-all').disabled = false;
    clearHover();
    render();
}
function selectedParts() {
    return highlightedGroup ? [...highlightedGroup.parts] : highlighted ? [highlighted] : [];
}
function selectPart(part, additive = false) {
    if (additive && part) {
        const parts = new Set(selectedParts());
        if (parts.has(part)) parts.delete(part);
        else parts.add(part);
        if (parts.size < 2) {
            selectPart([...parts][0] || null);
            return;
        }
        selectPart(null);
        highlightedGroup = { id: null, parts };
        const bounds = new THREE.Box3();
        for (const item of parts) bounds.union(new THREE.Box3().setFromObject(item));
        engine.selectionBox = new THREE.Box3Helper(bounds, 0x5e862e);
        engine.selectionBox.material.depthTest = false;
        engine.selectionBox.renderOrder = 4;
        engine.scene.add(engine.selectionBox);
        $('selected-name').textContent = 'Выбрано деталей: ' + parts.size;
        $('selected-info').textContent = 'Shift + клик - добавить или убрать деталь';
        $('part-dimensions').textContent = dimensionText(bounds.getSize(new THREE.Vector3()).toArray());
        render();
        return;
    }
    highlightedGroup = null;
    if (highlighted) highlighted.material.emissive.setHex(0);
    disposeObject(engine.selectionBox);
    engine.selectionBox = null;
    highlighted = part;
    for (const id of ['focus-part', 'isolate-part']) $(id).disabled = !part;
    if (part) {
        part.material.emissive.setHex(0x263e0a);
        const bounds = new THREE.Box3().setFromObject(part);
        engine.selectionBox = new THREE.Box3Helper(bounds, 0x5e862e);
        engine.selectionBox.material.depthTest = false;
        engine.selectionBox.renderOrder = 4;
        engine.scene.add(engine.selectionBox);
        $('selected-name').textContent = part.name;
        $('part-position').textContent = part.userData.artPos || 'Не указана';
        $('part-dimensions').textContent = dimensionText(part.userData.dimensions);
        $('selected-info').textContent = part.userData.materialName || 'Не указан';
        $('part-layers').hidden = !part.userData.isLayered;
        $('part-layers-list').replaceChildren();
        if (part.userData.isLayered) {
            $('part-layer-total').textContent =
                part.userData.layers.map((layer) => mm(layer.thickness)).join(' + ') +
                ' = ' +
                mm(part.userData.thickness) +
                ' мм';
            for (const layer of part.userData.layers) {
                const row = document.createElement('li');
                row.textContent =
                    layer.name + ' · ' + mm(layer.thickness) + ' мм · ' + (layer.materialName || 'Материал не указан');
                $('part-layers-list').append(row);
            }
        }
    } else {
        $('selected-name').textContent = 'Не выбрана';
        $('part-position').textContent = '-';
        $('part-dimensions').textContent = '-';
        $('selected-info').textContent = 'Нажмите на панель в модели';
        $('part-layers').hidden = true;
        $('part-layers-list').replaceChildren();
    }
    renderPositionSearch();
    updateColorControls();
    render();
}
function treeVisibilityChanged() {
    if (!model) return;
    isolated = false;
    model.hardware.visible = $('hardware').checked;
    $('isolate-part').setAttribute('aria-pressed', 'false');
    $('show-all').disabled = !model.panels.some((panel) => !panel.visible);
    selectPart(null);
}
function treeBounds(indices) {
    const bounds = new THREE.Box3();
    for (const index of indices)
        if (model.panels[index]) bounds.union(new THREE.Box3().setFromObject(model.panels[index]));
    return bounds;
}
function focusTreeParts(indices) {
    if (!model) return;
    for (const index of indices) model.panels[index].visible = true;
    isolated = false;
    model.hardware.visible = $('hardware').checked;
    $('isolate-part').setAttribute('aria-pressed', 'false');
    $('show-all').disabled = !model.panels.some((panel) => !panel.visible);
    renderPositionSearch();
    const bounds = treeBounds(indices);
    if (!bounds.isEmpty()) fit(null, bounds);
}
function selectTreeGroup(node) {
    if (!model || !engine) return;
    selectPart(null);
    highlightedGroup = { id: node.id, parts: new Set(node.indices.map((index) => model.panels[index])) };
    const bounds = treeBounds(node.indices);
    if (!bounds.isEmpty()) {
        engine.selectionBox = new THREE.Box3Helper(bounds, 0x5e862e);
        engine.selectionBox.material.depthTest = false;
        engine.selectionBox.renderOrder = 4;
        engine.scene.add(engine.selectionBox);
    }
    $('selected-name').textContent = node.name;
    $('selected-info').textContent = node.indices.length + ' деталей в группе';
    $('part-dimensions').textContent = dimensionText(bounds.getSize(new THREE.Vector3()).toArray());
    render();
}
function findPartsByPosition(query) {
    if (!model) return [];
    const text = query.trim().toLocaleLowerCase();
    const positioned = model.panels.filter((panel) => Boolean(panel.userData.artPos));
    const exact = text ? positioned.filter((panel) => panel.userData.artPos.toLocaleLowerCase() === text) : [];
    return (
        exact.length
            ? exact
            : positioned.filter((panel) => !text || panel.userData.artPos.toLocaleLowerCase().includes(text))
    ).sort((a, b) => {
        const ap = a.userData.artPos || '',
            bp = b.userData.artPos || '';
        const exactA = text && ap.toLocaleLowerCase() === text,
            exactB = text && bp.toLocaleLowerCase() === text;
        if (Boolean(exactA) !== Boolean(exactB)) return exactA ? -1 : 1;
        return ap.localeCompare(bp, 'ru', { numeric: true }) || a.name.localeCompare(b.name, 'ru');
    });
}
function renderPositionSearch() {
    const list = $('position-results');
    list.replaceChildren();
    const results = findPartsByPosition($('position-search').value || '');
    $('position-count').textContent = results.length;
    for (const panel of results) {
        const button = document.createElement('button');
        button.className = 'position-result' + (panel === highlighted ? ' active' : '');
        button.setAttribute('aria-pressed', String(panel === highlighted));
        const position = document.createElement('strong');
        position.textContent = panel.userData.artPos ? 'Поз. ' + panel.userData.artPos : 'Без позиции';
        const name = document.createElement('span');
        name.textContent = panel.name;
        const dimensions = document.createElement('small');
        dimensions.textContent = dimensionText(panel.userData.dimensions) + ' мм' + (!panel.visible ? ' · скрыта' : '');
        button.append(position, name, dimensions);
        button.onclick = () => {
            if (isolated) showAll();
            panel.visible = true;
            selectPart(panel);
            fit(null, new THREE.Box3().setFromObject(panel));
            $('show-all').disabled = !model.panels.some((item) => !item.visible);
        };
        list.append(button);
    }
    if (!results.length) {
        const empty = document.createElement('p');
        empty.className = 'help';
        empty.textContent = model ? 'Детали с такой позицией не найдены.' : 'Сначала откройте модель.';
        list.append(empty);
    }
    applyTransparency();
}
function snapFeatures(part) {
    if (part.userData.snapFeatures) return part.userData.snapFeatures;
    const positions = part.geometry.attributes.position,
        index = part.geometry.index;
    const vertices = [],
        seen = new Set(),
        faces = new Map(),
        edges = [];
    const vertex = (i) => new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(part.matrixWorld);
    for (let i = 0; i < positions.count; i++) {
        const p = vertex(i),
            key = p
                .toArray()
                .map((v) => Math.round(v * 10000))
                .join(',');
        if (!seen.has(key)) {
            seen.add(key);
            vertices.push(p);
        }
    }
    const outline = part.children.find((child) => child.isLineSegments);
    if (outline) {
        const attr = outline.geometry.attributes.position;
        for (let i = 0; i < attr.count; i += 2)
            edges.push([
                new THREE.Vector3().fromBufferAttribute(attr, i).applyMatrix4(part.matrixWorld),
                new THREE.Vector3().fromBufferAttribute(attr, i + 1).applyMatrix4(part.matrixWorld)
            ]);
    }
    const count = index ? index.count : positions.count;
    for (let i = 0; i < count; i += 3) {
        const triangle = new THREE.Triangle(
            vertex(index ? index.getX(i) : i),
            vertex(index ? index.getX(i + 1) : i + 1),
            vertex(index ? index.getX(i + 2) : i + 2)
        );
        const area = triangle.getArea();
        if (area < 1e-8) continue;
        const normal = triangle.getNormal(new THREE.Vector3()),
            plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, triangle.a);
        const key = normal
            .toArray()
            .map((v) => Math.round(v * 10000))
            .concat(Math.round(plane.constant * 1000))
            .join(',');
        let face = faces.get(key);
        if (!face) {
            face = { plane, center: new THREE.Vector3(), area: 0, triangles: [] };
            faces.set(key, face);
        }
        face.center.addScaledVector(triangle.getMidpoint(new THREE.Vector3()), area);
        face.area += area;
        face.triangles.push(triangle);
    }
    for (const face of faces.values()) face.center.divideScalar(face.area);
    const result = { vertices, edges, faces: [...faces.values()] };
    part.userData.snapFeatures = result;
    return result;
}
function onFace(point, face) {
    return (
        Math.abs(face.plane.distanceToPoint(point)) < 0.02 &&
        face.triangles.some((triangle) => triangle.containsPoint(point))
    );
}
function snapPoint(hit, event) {
    const rect = engine.renderer.domElement.getBoundingClientRect(),
        projected = new THREE.Vector3();
    const features = snapFeatures(hit.object);
    const pixelSize = engine.camera.isOrthographicCamera
        ? (engine.camera.top - engine.camera.bottom) / engine.camera.zoom / rect.height
        : (2 * hit.point.distanceTo(engine.camera.position) * Math.tan((engine.camera.fov * Math.PI) / 360)) /
          rect.height;
    const candidates = [];
    function offer(point, type, priority, radius = 14) {
        if (!sectionTools.isVisible(point)) return;
        if (point.distanceTo(hit.point) > pixelSize * 22) return;
        projected.copy(point).project(engine.camera);
        if (projected.z < -1 || projected.z > 1) return;
        const distance = Math.hypot(
            ((projected.x + 1) * rect.width) / 2 + rect.left - event.clientX,
            ((1 - projected.y) * rect.height) / 2 + rect.top - event.clientY
        );
        if (distance <= radius) candidates.push({ point: point.clone(), type, priority, distance, snapped: true });
    }
    if (heldSnap && heldSnap.part === hit.object) offer(heldSnap.point, heldSnap.type, -1, 22);
    for (const vertex of features.vertices) offer(vertex, 'vertex', 0);
    for (const edge of features.edges) offer(edge[0].clone().add(edge[1]).multiplyScalar(0.5), 'midpoint', 1);
    for (const face of features.faces) {
        if (Math.abs(face.plane.distanceToPoint(hit.point)) > 0.03) continue;
        if (onFace(face.center, face)) offer(face.center, 'center', 2);
        if (pendingPoint) {
            const projection = face.plane.projectPoint(pendingPoint.point, new THREE.Vector3());
            if (projection.distanceTo(pendingPoint.point) > 0.01 && onFace(projection, face))
                offer(projection, 'plane', 3, 22);
        }
    }
    {
        const ray = new THREE.Raycaster();
        ray.setFromCamera(
            new THREE.Vector2(
                ((event.clientX - rect.left) / rect.width) * 2 - 1,
                (-(event.clientY - rect.top) / rect.height) * 2 + 1
            ),
            engine.camera
        );
        for (const edge of features.edges) {
            const point = new THREE.Vector3();
            ray.ray.distanceSqToSegment(edge[0], edge[1], new THREE.Vector3(), point);
            offer(point, 'edge', 4, 10);
        }
    }
    candidates.sort((a, b) => a.priority - b.priority || a.distance - b.distance);

    for (const candidate of candidates) {
        const direction = candidate.point.clone().sub(engine.camera.position);
        let distance = direction.length();

        const ray = new THREE.Raycaster(engine.camera.position.clone(), direction.normalize(), 0, distance + 0.02);
        if (engine.camera.isOrthographicCamera) {
            const screen = candidate.point.clone().project(engine.camera);
            ray.setFromCamera(new THREE.Vector2(screen.x, screen.y), engine.camera);
            distance = candidate.point.clone().sub(ray.ray.origin).dot(ray.ray.direction);
            ray.far = distance + 0.02;
        }
        const occluder = ray
            .intersectObjects(model ? model.panels.filter((panel) => panel.visible) : [hit.object])
            .find((hit) => sectionTools.isVisible(hit.point));
        if (!occluder || occluder.distance >= distance - 0.03) return candidate;
    }
    return { point: hit.point.clone(), snapped: false, type: 'surface' };
}
function clearHover() {
    disposeObject(hoverGraphic);
    hoverGraphic = null;
    heldSnap = null;
    $('snap-label').hidden = true;
    $('snap-cursor').hidden = true;
    $('canvas').classList.remove('snap-magnet');
}
function showSnapPreview(result, event) {
    clearHover();
    hoverGraphic = measurementGraphic([result.point]);
    if (result.snapped) {
        const hit = pick(event);
        if (result.type !== 'edge' && hit)
            heldSnap = { point: result.point.clone(), type: result.type, part: hit.object };
        const point = result.point.clone().project(engine.camera),
            rect = engine.renderer.domElement.getBoundingClientRect();
        $('snap-cursor').style.left = rect.left + ((point.x + 1) * rect.width) / 2 + 'px';
        $('snap-cursor').style.top = rect.top + ((1 - point.y) * rect.height) / 2 + 'px';
        $('snap-cursor').hidden = false;
        $('canvas').classList.add('snap-magnet');
    }
    const color = result.snapped ? 0x3f7c28 : 0x277fb4;
    hoverGraphic.children[0].material.color.setHex(color);
    hoverGraphic.children[0].material.size = result.type === 'vertex' ? 12 : 9;
    const rect = $('canvas').getBoundingClientRect();
    $('snap-label').textContent = snapNames[result.type];
    $('snap-label').hidden = false;
    $('snap-label').style.left = Math.min(event.clientX - rect.left + 18, Math.max(0, rect.width - 190)) + 'px';
    $('snap-label').style.top = Math.max(0, Math.min(event.clientY - rect.top + 15, rect.height - 40)) + 'px';
    $('snap-status').textContent =
        snapNames[result.type] + (pendingPoint ? ' · ' + mm(pendingPoint.point.distanceTo(result.point)) + ' мм' : '');
    render();
}
function measurementValues(a, b) {
    const delta = b.clone().sub(a);
    return { length: delta.length(), axes: [Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.z)] };
}
function measurementGraphic(points) {
    const group = new THREE.Group();
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const dotMaterial = new THREE.PointsMaterial({
        color: 0x547a32,
        size: 6,
        sizeAttenuation: false,
        depthTest: false
    });
    dotMaterial.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
            'void main() {',
            'void main() {\n if (distance(gl_PointCoord, vec2(0.5)) > 0.5) discard;'
        );
    };
    const dots = new THREE.Points(geometry, dotMaterial);
    dots.renderOrder = 10;
    group.add(dots);
    if (points.length > 1) {
        const line = new THREE.Line(
            geometry.clone(),
            new THREE.LineBasicMaterial({ color: 0x547a32, depthTest: false })
        );
        line.renderOrder = 9;
        group.add(line);
    }
    engine.scene.add(group);
    return group;
}
function addMeasurementPoint(result) {
    clearHover();
    if (!pendingPoint) {
        pendingPoint = result;
        pendingMarker = measurementGraphic([result.point]);
        $('snap-status').textContent =
            'Первая точка: ' +
            (snapNames[result.type] || (result.snapped ? 'вершина' : 'поверхность')) +
            '. Выберите вторую точку. Esc - отмена.';
    } else {
        const values = measurementValues(pendingPoint.point, result.point);
        if (values.length < 0.01) {
            $('snap-status').textContent = 'Точки совпадают. Выберите другую точку.';
            return;
        }
        const a = pendingPoint.point,
            b = result.point;
        const graphic = measurementGraphic([a, b]),
            label = document.createElement('span');
        label.className = 'measurement-label';
        label.textContent = mm(values.length) + ' мм';
        $('labels').append(label);
        measurements.push({
            a,
            b,
            values,
            graphic,
            label,
            snapped: pendingPoint.snapped && result.snapped,
            types: [pendingPoint.type || 'vertex', result.type || 'vertex']
        });
        cancelPending();
        $('snap-status').textContent = 'Размер добавлен. Выберите две точки для следующего измерения.';
    }
    renderMeasurements();
    render();
}
function cancelPending() {
    pendingPoint = null;
    disposeObject(pendingMarker);
    pendingMarker = null;
}
function removeMeasurement(index) {
    const entry = measurements.splice(index, 1)[0];
    if (entry) {
        disposeObject(entry.graphic);
        entry.label.remove();
    }
    renderMeasurements();
    render();
}
function clearMeasurements() {
    cancelPending();
    while (measurements.length) removeMeasurement(measurements.length - 1);
    renderMeasurements();
    render();
}
function renderMeasurements() {
    $('measure-count').textContent = measurements.length;
    $('measure-list').replaceChildren();
    measurements.forEach((entry, index) => {
        const row = document.createElement('li'),
            text = document.createElement('div');
        text.className = 'measure-text';
        const title = document.createElement('strong');
        title.textContent = index + 1 + '. ' + mm(entry.values.length) + ' мм';
        const detail = document.createElement('small');
        detail.textContent =
            'ΔX ' +
            mm(entry.values.axes[0]) +
            ' · ΔY ' +
            mm(entry.values.axes[1]) +
            ' · ΔZ ' +
            mm(entry.values.axes[2]) +
            ' мм';
        const remove = document.createElement('button');
        remove.textContent = '×';
        remove.setAttribute('aria-label', 'Удалить измерение ' + (index + 1));
        remove.onclick = () => removeMeasurement(index);
        text.append(title, detail);
        row.append(text, remove);
        $('measure-list').append(row);
    });
    if (pendingPoint) {
        const item = document.createElement('li');
        item.className = 'pending';
        item.textContent = '● Первая точка установлена…';
        $('measure-list').append(item);
    }
    $('undo-measure').disabled = !pendingPoint && !measurements.length;
    $('clear-measures').disabled = !pendingPoint && !measurements.length;
}
function setTool(value) {
    tool = value;
    cancelPending();
    clearHover();
    renderMeasurements();
    $('canvas').classList.toggle('measuring', value === 'measure');
    $('snap-status').textContent =
        value === 'measure'
            ? 'Выберите две точки. Привязка подсвечивается перед кликом.'
            : 'Нажмите на деталь, чтобы увидеть её габариты.';
    $('mode-hint').textContent =
        value === 'measure'
            ? 'Линейка: два клика · Esc - отмена · Перетаскивание - вращение'
            : 'Мышь - вращение · Колесо - масштаб · ПКМ - перемещение';
    render();
}
function openTab(name, changeMode = true) {
    if (!tabNames[name]) return;
    if ($('tab-' + name).hidden) return;
    if (name !== 'materials') {
        choosingLightFace = false;
        $('canvas').classList.remove('choosing-light-face');
    }
    activeTab = name;
    for (const key of Object.keys(tabNames)) {
        $('pane-' + key).hidden = key !== name;
        $('tab-' + key).setAttribute('aria-selected', String(key === name));
        $('tab-' + key).tabIndex = key === name ? 0 : -1;
    }
    $('panel-title').textContent = tabNames[name];
    $('panel-units').hidden = ['search', 'measure', 'tree'].includes(name);
    $('position-count').hidden = name !== 'search';
    $('measure-count').hidden = name !== 'measure';
    $('app').classList.remove('panel-closed');
    $('toggle-panel').setAttribute('aria-expanded', 'true');
    $('toggle-panel').setAttribute('aria-label', 'Скрыть панель инструментов');
    $('toggle-panel').title = 'Скрыть панель';
    if (changeMode) setTool(name === 'measure' ? 'measure' : 'select');
}

function updateMaterialGlow(panel) {
    const material = panel.material,
        map = panel.userData.glow ? material.map : null;
    if (material.emissiveMap !== map) {
        material.emissiveMap = map;
        material.needsUpdate = true;
    }
    if (panel.userData.glow) material.emissive.set((panel.userData.light || defaultLight).color).convertSRGBToLinear();
    else material.emissive.setHex(panel === highlighted || highlightedGroup?.parts.has(panel) ? 0x263e0a : 0);
    material.emissiveIntensity = panel.userData.glow ? (panel.userData.light || defaultLight).power : 1;
    const shader = material.userData.ledShader,
        face = panel.userData.light?.face;
    if (shader) {
        shader.uniforms.ledDirectional.value = Array.isArray(face) ? 1 : 0;
        if (face) {
            shader.uniforms.ledFace.value.fromArray(face);
            if (panel.userData.localMatrix)
                shader.uniforms.ledFace.value.transformDirection(panel.userData.localMatrix);
        }
    }
}
function updateLEDLights() {
    if (!window.LEDLighting) return;
    if (!ledBaker)
        ledBaker = new LEDLighting.Baker(render, (text) => {
            $('light-status').textContent = text;
        });
    const signature = model
        ? model.panels.map((panel) => (panel.visible ? '1' : '0')).join('') +
          '|' +
          model.panels
              .filter((panel) => panel.userData.glow)
              .map((panel) => panel.uuid + ':' + JSON.stringify(panel.userData.light || defaultLight))
              .join('|')
        : '';
    ledBaker.update(model, signature);
}
function colorTargets() {
    if (!model) return [];
    const scope = $('color-scope').value;
    if (scope === 'all') return model.panels;
    if (!highlighted) return [];
    if (scope === 'material' && highlighted.userData.materialName)
        return model.panels.filter((panel) => panel.userData.materialName === highlighted.userData.materialName);
    return [highlighted];
}
function lightTargets() {
    return model && highlighted && model.panels.includes(highlighted) ? [highlighted] : [];
}
function displayColor(panel) {
    return '#' + panel.material.color.clone().convertLinearToSRGB().getHexString().toUpperCase();
}
function updateColorControls() {
    const glowTargets = lightTargets();
    $('material-glow').disabled = !glowTargets.length;
    $('material-glow').checked = glowTargets.length > 0 && glowTargets.every((panel) => panel.userData.glow);
    $('material-glow').indeterminate = glowTargets.some((panel) => panel.userData.glow) && !$('material-glow').checked;
    $('choose-light-face').disabled = !glowTargets.length;
    $('choose-light-face').textContent = glowTargets[0]?.userData.light?.face
        ? 'Изменить светящуюся грань'
        : 'Выбрать светящуюся грань';
    const light = glowTargets[0]?.userData.light || defaultLight;
    for (const key of ['color', 'power', 'distance']) {
        $('light-' + key).value = light[key];
        $('light-' + key).disabled = !glowTargets.length;
    }
    $('light-power-value').textContent = mm(light.power);
    const targets = colorTargets(),
        enabled = targets.length > 0;
    for (const id of ['material-color', 'color-hex', 'reset-color']) $(id).disabled = !enabled;
    $('reset-all-colors').disabled = !model;
    for (const button of $('color-swatches').children) button.disabled = !enabled;
    if (!enabled) {
        $('color-target').textContent = 'Выберите деталь или материал';
        $('color-info').textContent = 'Выберите панель в 3D или материал в списке ниже.';
    } else {
        const color = displayColor(targets[0]);
        $('material-color').value = color;
        $('color-hex').value = color;
        const sameColor = targets.every((panel) => displayColor(panel) === color);
        $('color-target').textContent =
            $('color-scope').value === 'all'
                ? 'Вся модель'
                : $('color-scope').value === 'material' && highlighted.userData.materialName
                  ? highlighted.userData.materialName
                  : highlighted.name;
        $('color-info').textContent =
            'Деталей: ' +
            targets.length +
            (sameColor ? ' · ' + color : ' · Сейчас заданы разные цвета') +
            (!highlighted?.userData.materialName && $('color-scope').value === 'material'
                ? '. Материал не указан - изменится только выбранная деталь.'
                : '');
    }
    syncTextureControls();
    renderMaterialList();
}
function syncTextureControls() {
    const targets = colorTargets(),
        texture = targets.length ? targets[0].userData.texture : null;
    $('load-texture').disabled = !targets.length;
    for (const id of ['texture-scale', 'texture-rotation', 'texture-orientation', 'texture-mirror', 'remove-texture'])
        $(id).disabled = !targets.some((panel) => panel.userData.texture);
    const asset = texture ? textureAssets.get(texture.asset) : null;
    $('texture-preview-wrap').hidden = !asset;
    $('texture-placeholder').hidden = Boolean(asset);
    if (!asset) {
        $('texture-preview').removeAttribute('src');
        $('texture-name').textContent = '';
    }
    if (texture) {
        if (asset) {
            $('texture-preview').src = asset.url;
            $('texture-name').textContent = asset.name;
        }
        $('texture-scale').value = texture.scale;
        $('texture-rotation').value = texture.rotation;
        $('texture-orientation').value = texture.orientation || 'auto';
        $('texture-mirror').checked = texture.mirror === true;
    } else {
        $('texture-preview').removeAttribute('src');
        $('texture-name').textContent = '';
    }
    setMaterialEditor(materialEditor === 'light' ? 'light' : texture ? 'texture' : 'color');
}
function setMaterialEditor(mode) {
    if (mode === 'light') {
        if (materialEditor !== 'light') savedColorScope = $('color-scope').value;
        $('color-scope').value = 'part';
        $('color-scope').disabled = true;
        $('color-target').textContent = highlighted ? highlighted.name : 'Выберите деталь';
    } else {
        $('color-scope').disabled = false;
        if (materialEditor === 'light' && savedColorScope) {
            $('color-scope').value = savedColorScope;
            savedColorScope = null;
        }
    }
    if (mode !== 'light') {
        choosingLightFace = false;
        $('canvas').classList.remove('choosing-light-face');
    }
    materialEditor = mode;
    $('material-light-editor').hidden = mode !== 'light';
    $('mode-light').setAttribute('aria-pressed', String(mode === 'light'));
    $('material-color-editor').hidden = mode !== 'color';
    $('material-texture-editor').hidden = mode !== 'texture';
    $('mode-color').setAttribute('aria-pressed', String(mode === 'color'));
    $('mode-texture').setAttribute('aria-pressed', String(mode === 'texture'));
}
async function loadTextureAsset(blob, name) {
    const token = request;
    if (blob.size > 8388608) throw new Error('Изображение должно быть не больше 8 МБ.');
    const hash = await TextureUtils.hash(await blob.arrayBuffer());
    if (textureAssets.has(hash)) return hash;
    const url = URL.createObjectURL(blob),
        image = new Image();
    try {
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error('Не удалось прочитать изображение. Используйте JPG, PNG или WebP.'));
            image.src = url;
        });
        if (token !== request) throw new Error('Модель была изменена');
        if (image.width > 8192 || image.height > 8192 || image.width * image.height > 40000000)
            throw new Error('Изображение слишком большое: максимум 8192 px и 40 мегапикселей.');
        textureAssets.set(hash, { blob, url, image, name });
        return hash;
    } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
    }
}
function updateTextureUV(panel, angle = 0) {
    const uv = panel.geometry.attributes.uv,
        base = panel.userData.baseUV;
    if (!uv || !base) return;
    uv.array.set(base);

    const edgeAngle = angle + Math.PI / 2;
    const c = Math.cos(edgeAngle),
        s = Math.sin(edgeAngle);
    for (const range of panel.userData.sideUVRanges || [])
        for (let i = range.start; i < range.start + range.count; i++) {
            const u = base[i * 2],
                v = base[i * 2 + 1];
            uv.setXY(i, c * u - s * v, s * u + c * v);
        }
    uv.needsUpdate = true;
}
function assignTexture(panel, specification) {
    const asset = specification ? textureAssets.get(specification.asset) : null;
    if (specification && !asset) throw new Error('Изображение текстуры не загружено');
    if (panel.material.map) panel.material.map.dispose();
    panel.material.map = null;
    if (!specification) {
        updateTextureUV(panel);
        delete panel.userData.texture;
        if (panel.userData.textureColor) {
            panel.material.color.copy(panel.userData.textureColor);
            delete panel.userData.textureColor;
        }
    } else {
        if (!panel.userData.textureColor) panel.userData.textureColor = panel.material.color.clone();
        panel.material.color.setHex(0xffffff);
        const map = new THREE.Texture(asset.image);
        map.encoding = THREE.sRGBEncoding;
        map.wrapS = map.wrapT = specification.mirror === true ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
        map.repeat.set(1 / specification.scale, asset.image.width / asset.image.height / specification.scale);
        const direction = specification.orientation || 'auto';
        const baseAngle = direction === 'x' ? Math.PI / 2 : direction === 'y' ? 0 : panel.userData.textureAngle || 0;

        map.matrixAutoUpdate = false;
        const angle = baseAngle + (specification.rotation * Math.PI) / 180,
            c = Math.cos(angle),
            s = Math.sin(angle);
        map.matrix.set(c * map.repeat.x, s * map.repeat.x, 0, -s * map.repeat.y, c * map.repeat.y, 0, 0, 0, 1);
        updateTextureUV(panel, angle);
        map.rotation = angle;
        map.anisotropy = engine.renderer.capabilities.getMaxAnisotropy
            ? Math.min(4, engine.renderer.capabilities.getMaxAnisotropy())
            : 1;
        map.needsUpdate = true;
        panel.material.map = map;
        panel.userData.texture = { ...specification };
    }
    panel.material.needsUpdate = true;
}
async function chooseTexture(file) {
    if (!file) return;
    const token = request,
        operation = ++textureOperation,
        targets = colorTargets().slice();
    if (!targets.length) return;
    $('texture-status').textContent = 'Чтение текстуры…';
    try {
        pruneTextureAssets();
        if (
            !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) &&
            !(file.type === '' && /\.(jpe?g|png|webp)$/i.test(file.name))
        )
            throw new Error('Поддерживаются JPG, PNG и WebP.');
        const asset = await loadTextureAsset(file, file.name);
        if (token !== request || operation !== textureOperation) return;
        const assigned = new Set(
            model.panels
                .filter((panel) => !targets.includes(panel) && panel.userData.texture)
                .map((panel) => panel.userData.texture.asset)
        );
        assigned.add(asset);
        if (assigned.size > 16) throw new Error('Максимум 16 разных текстур в проекте.');
        for (const panel of targets)
            assignTexture(panel, { asset, scale: 500, rotation: 0, orientation: 'auto', mirror: true });
        pruneTextureAssets();
        syncTextureControls();
        render();
        $('texture-status').textContent =
            'Текстура назначена с направлением из B3D для каждой детали. Обновите проект для сохранения.';
    } catch (error) {
        if (token === request) $('texture-status').textContent = error.message;
    }
}
function pruneTextureAssets() {
    const used = new Set(
        model ? model.panels.filter((panel) => panel.userData.texture).map((panel) => panel.userData.texture.asset) : []
    );
    for (const [hash, asset] of textureAssets)
        if (!used.has(hash)) {
            URL.revokeObjectURL(asset.url);
            textureAssets.delete(hash);
        }
}
function changeTextureTransform() {
    const scale = Number($('texture-scale').value),
        rotation = Number($('texture-rotation').value);
    if (!Number.isFinite(scale) || scale < 10 || scale > 10000) {
        $('texture-status').textContent = 'Размер рисунка: от 10 до 10000 мм.';
        return;
    }
    for (const panel of colorTargets())
        if (panel.userData.texture)
            assignTexture(panel, {
                ...panel.userData.texture,
                scale,
                rotation,
                mirror: $('texture-mirror').checked,
                orientation: $('texture-orientation').value
            });
    syncTextureControls();
    render();
}

function renderMaterialList() {
    $('material-list').replaceChildren();
    if (!model) return;
    const groups = new Map();
    for (const panel of model.panels) {
        const name = panel.userData.materialName || 'Без указанного материала';
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(panel);
    }
    for (const [name, panels] of groups) {
        const button = document.createElement('button');
        button.className = 'material-item' + (highlighted && panels.includes(highlighted) ? ' active' : '');
        const chip = document.createElement('span');
        chip.className = 'material-chip';
        chip.style.background = displayColor(panels[0]);
        const text = document.createElement('span');
        text.className = 'material-text';
        text.textContent = name;
        const count = document.createElement('small');
        count.textContent = panels.length + ' деталей';
        text.append(count);
        button.append(chip, text);
        button.onclick = () => {
            if (isolated) showAll();
            $('color-scope').value = 'material';
            selectPart(panels[0]);
        };
        $('material-list').append(button);
    }
}
function applyColor(value) {
    if (!/^#[0-9a-f]{6}$/i.test(value)) {
        $('color-info').textContent = 'Введите HEX-цвет в формате #AABBCC.';
        return;
    }
    const targets = colorTargets();
    for (const panel of targets) {
        if (panel.userData.texture) assignTexture(panel, null);
        if (!panel.userData.originalColor) panel.userData.originalColor = panel.material.color.clone();
        panel.material.color.set(value).convertSRGBToLinear();
    }
    updateColorControls();
    render();
}
function resetColors(all) {
    const targets = all && model ? model.panels : colorTargets();
    for (const panel of targets)
        if (panel.userData.originalColor) {
            if (panel.userData.textureColor) panel.userData.textureColor.copy(panel.userData.originalColor);
            else panel.material.color.copy(panel.userData.originalColor);
            delete panel.userData.originalColor;
        }
    updateColorControls();
    render();
}
function showAll() {
    if (!model) return;
    model.panels.forEach((panel) => {
        panel.visible = true;
    });
    isolated = false;
    model.hardware.visible = $('hardware').checked;
    $('isolate-part').setAttribute('aria-pressed', 'false');
    $('show-all').disabled = true;
    renderPositionSearch();
    render();
}
function setGrid() {
    if (!model) return;
    disposeObject(engine.grid);
    const size = model.bounds.getSize(new THREE.Vector3()),
        center = model.bounds.getCenter(new THREE.Vector3()),
        extent = Math.max(...size.toArray());
    const grid = new THREE.Group(),
        span = Math.ceil((extent * 2) / 100) * 100;
    const helper = new THREE.GridHelper(span, 20, 0x53677d, 0x3a4c60);
    helper.position.set(center.x, model.bounds.min.y - 1, center.z);
    helper.material.transparent = true;
    helper.material.opacity = 0.4;
    const axes = new THREE.AxesHelper(extent * 0.22);
    axes.position.copy(model.bounds.min);
    grid.add(helper, axes);
    grid.visible = $('grid').checked;
    engine.grid = grid;
    engine.scene.add(grid);
}
function clearModel() {
    sectionTools.reset();
    if (ledBaker) ledBaker.clear();
    choosingLightFace = false;
    $('canvas').classList.remove('choosing-light-face');
    closePartMenu();
    clearMeasurements();
    clearHover();
    if (engine) {
        selectPart(null);
        disposeObject(engine.grid);
        engine.grid = null;
        disposeObject(engine.shadowFloor);
        engine.shadowFloor = null;
    }
    isolated = false;
    $('isolate-part').setAttribute('aria-pressed', 'false');
    $('show-all').disabled = true;
    if (!model || !engine) return;
    for (const group of [model.group, model.hardware]) {
        engine.scene.remove(group);
        group.traverse((object) => {
            if (object.geometry) object.geometry.dispose();
            if (object.material) {
                if (object.material.map) object.material.map.dispose();
                object.material.dispose();
            }
        });
    }
    for (const asset of textureAssets.values()) URL.revokeObjectURL(asset.url);
    textureAssets.clear();
    textureOperation++;
    model = null;
    renderPositionSearch();
    updateColorControls();
    render();
}

function fit(direction, bounds) {
    if (!model) return;
    const box = bounds || (isolated && highlighted ? new THREE.Box3().setFromObject(highlighted) : model.bounds);
    const { camera, controls } = engine,
        center = box.getCenter(new THREE.Vector3()),
        size = box.getSize(new THREE.Vector3());
    const radius = size.length() / 2,
        vFov = (camera.fov * Math.PI) / 180,
        hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const distance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.12;
    const dir = direction || camera.position.clone().sub(controls.target).normalize();
    camera.zoom = 1;
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(dir, distance);
    camera.near = Math.max(0.1, radius / 1000);
    camera.far = Math.max(100000, radius * 100);
    camera.updateProjectionMatrix();
    controls.minDistance = radius * 0.05;
    controls.maxDistance = radius * 40;
    engine.baseDistance = distance;
    controls.update();
    render();
}
function zoom(factor) {
    if (!model) return;
    const { camera, controls } = engine;
    const offset = camera.position.clone().sub(controls.target);
    const distance = Math.max(controls.minDistance, Math.min(controls.maxDistance, offset.length() / factor));
    camera.position.copy(controls.target).add(offset.setLength(distance));
    controls.update();
    render();
}
function inflateModel(bytes) {
    const raw = new pako.Inflate({ raw: true, chunkSize: 65536 }),
        chunks = [];
    let total = 0;
    raw.onData = (chunk) => {
        total += chunk.length;
        if (total > 256 * 1024 * 1024) throw new Error('Распакованный файл превышает 256 МБ');
        chunks.push(chunk.slice());
    };
    raw.push(bytes.subarray(2), true);
    if (raw.err || !raw.ended) throw new Error('Не удалось распаковать геометрию B3D');
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
    }

    const consumed = raw.strm.next_in,
        end = 2 + consumed;
    if (end + 4 > bytes.length) throw new Error('Оборванная контрольная сумма B3D');
    let a = 1,
        b = 0;
    for (let i = 0; i < output.length; i++) {
        a = (a + output[i]) % 65521;
        b = (b + a) % 65521;
    }
    const expected = new DataView(bytes.buffer, bytes.byteOffset + end, 4).getUint32(0);
    if (((b << 16) | a) >>> 0 !== expected) throw new Error('Неверная контрольная сумма B3D');
    return output;
}
async function openFile(file) {
    const token = ++request;
    selected = file;
    clearModel();
    $('title').textContent = $('detail-name').textContent = file.name;
    $('size').textContent = sizeLabel(file.size);
    $('modified').textContent = new Date(file.modified).toLocaleString('ru-RU');
    for (const id of ['format', 'dimensions', 'model-stats']) $(id).textContent = '-';
    $('selected-name').textContent = 'Не выбрана';
    $('selected-info').textContent = 'Нажмите на панель в модели';
    $('message').hidden = false;
    $('message').textContent = 'Чтение 3D-геометрии…';
    $('status').textContent = 'Загрузка…';
    try {
        initialize3D();
        if (file.size > 128 * 1024 * 1024) throw new Error('Файл превышает лимит просмотра 128 МБ.');
        const buffer = await file.local.arrayBuffer();
        if (token !== request) return;
        const parsed = BazisB3D.parse(buffer, inflateModel),
            next = BazisScene.build(parsed, THREE);
        if (!next.panels.length) {
            for (const g of [next.group, next.hardware])
                g.traverse((o) => {
                    if (o.geometry) o.geometry.dispose();
                    if (o.material) o.material.dispose();
                });
            throw new Error('Поддерживаемая геометрия не найдена в модели.');
        }
        model = next;
        treeTools.setModel(model, file.name);
        engine.scene.add(model.group, model.hardware);
        model.hardware.visible = $('hardware').checked;
        $('position-search').value = '';
        setGrid();
        applyEdges();
        renderPositionSearch();
        updateColorControls();
        applyTransparency();
        applyRenderSettings();
        $('format').textContent = 'БАЗИС B3D · BZ85';
        const size = model.bounds.getSize(new THREE.Vector3());
        $('dimensions').textContent = dimensionText(size.toArray());
        $('model-stats').textContent =
            model.stats.panels +
            ' панелей · ' +
            model.stats.hardware +
            ' элементов фурнитуры' +
            (model.stats.layered ? ' · многослойных: ' + model.stats.layered : '');
        $('status').textContent =
            '3D-модель загружена' +
            (model.stats.unsupported
                ? ' · Не отображено объектов: ' + model.stats.unsupported
                : ' · Все панели прочитаны');
        if (model.warnings.length) console.warn('B3D:', model.warnings);
        $('message').hidden = true;
        fit(new THREE.Vector3(1, 0.65, 1.8).normalize());
    } catch (error) {
        if (token !== request) return;
        $('message').textContent = error.message;
        $('status').textContent = 'Ошибка открытия 3D-модели';
        console.error(error);
    }
}
function applyTransparency() {
    if (!model) return;
    const searching = Boolean(($('position-search').value || '').trim()),
        matches = new Set(searching ? findPartsByPosition($('position-search').value) : []);
    for (const panel of model.panels) {
        const ghost = searching ? !matches.has(panel) : $('transparent').checked;
        panel.material.transparent = ghost;
        panel.material.opacity = ghost ? (searching ? 0.16 : 0.28) : 1;
        panel.material.depthWrite = !ghost;
        panel.material.needsUpdate = true;
        panel.castShadow = renderSettings.shadows && !ghost;
        panel.children.forEach((child) => {
            if (child.isLineSegments) child.material.opacity = ghost && searching ? 0.12 : 0.85;
        });
    }
    render();
}
function applyEdges() {
    if (!model) return;
    for (const panel of model.panels)
        panel.children.forEach((child) => {
            child.visible = $('edges').checked;
        });
    render();
}
function renderLocalFiles() {
    const list = $('local-files');
    list.replaceChildren();
    if (!files.length) {
        const empty = document.createElement('p');
        empty.className = 'help';
        empty.textContent = 'Файлы ещё не открыты.';
        list.append(empty);
    }
    for (const file of files) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'wide';
        button.textContent = file.name + ' · ' + sizeLabel(file.size);
        button.onclick = () => openFile(file);
        list.append(button);
    }
}
function addFiles(items) {
    const accepted = [...items].filter((f) => /\.b3d$/i.test(f.name));
    if (!accepted.length) {
        $('status').textContent = 'Выберите файл .b3d';
        return;
    }
    for (const local of accepted)
        files.push({ name: local.name, size: local.size, modified: new Date(local.lastModified).toISOString(), local });
    renderLocalFiles();
    openFile(files[files.length - accepted.length]);
}
$('open').onclick = () => $('file-input').click();
$('file-input').onchange = (e) => {
    addFiles(e.target.files);
    e.target.value = '';
};
$('welcome-open').onclick = () => $('file-input').click();
for (const key of Object.keys(renderDefaults)) {
    const field = $('render-' + (key === 'shadowQuality' ? 'shadow-quality' : key));
    const update = () => {
        const value =
            typeof renderDefaults[key] === 'boolean'
                ? field.checked
                : typeof renderDefaults[key] === 'number'
                  ? Number(field.value)
                  : field.value;
        renderSettings = normalizeRenderSettings({ ...renderSettings, [key]: value });
        applyRenderSettings();
    };
    if (field.type === 'range' || field.type === 'color') field.oninput = update;
    else field.onchange = update;
}
for (const name of Object.keys(renderPresets))
    $('render-' + name).onclick = () => {
        renderSettings = { ...renderPresets[name] };
        applyRenderSettings();
    };
for (const [name, color] of Object.entries({ white: '#ffffff', gray: '#dfe5eb', dark: '#202b39' }))
    $('render-bg-' + name).onclick = () => {
        renderSettings.background = color;
        applyRenderSettings();
    };
$('render-reset').onclick = () => {
    renderSettings = { ...renderDefaults };
    applyRenderSettings();
};
$('zoom-in').onclick = () => zoom(1.2);
$('zoom-out').onclick = () => zoom(1 / 1.2);
initializeViewCube();
$('transparent').onchange = applyTransparency;
$('hardware').onchange = () => {
    if (model) {
        model.hardware.visible = $('hardware').checked && !isolated;
        render();
    }
};
$('selection-hardware').onchange = render;
$('perspective').onchange = () => setPerspective($('perspective').checked);
$('grid').onchange = () => {
    if (engine && engine.grid) {
        engine.grid.visible = $('grid').checked;
        render();
    }
};
$('edges').onchange = applyEdges;
$('fullscreen').onclick = async () => {
    try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await $('app').requestFullscreen();
    } catch {
        $('status').textContent = 'Полный экран недоступен';
    }
};
$('focus-part').onclick = () => highlighted && fit(null, new THREE.Box3().setFromObject(highlighted));
$('isolate-part').onclick = () => {
    if (!highlighted) return;
    if (isolated) showAll();
    else {
        model.panels.forEach((panel) => {
            panel.visible = panel === highlighted;
        });
        model.hardware.visible = false;
        isolated = true;
        $('isolate-part').setAttribute('aria-pressed', 'true');
        $('show-all').disabled = false;
        fit();
    }
};
$('show-all').onclick = showAll;
$('header-show-all').onclick = showAll;
$('header-focus').onclick = () => {
    if (!model) return;
    if (highlightedGroup)
        focusTreeParts(model.panels.flatMap((panel, index) => (highlightedGroup.parts.has(panel) ? [index] : [])));
    else if (highlighted) focusTreeParts([model.panels.indexOf(highlighted)]);
};
$('position-search').oninput = renderPositionSearch;
$('clear-position-search').onclick = () => {
    $('position-search').value = '';
    renderPositionSearch();
    $('position-search').focus();
};
$('hide-part').onclick = () => {
    if (highlightedGroup?.parts.size > 1) {
        const parts = selectedParts();
        closePartMenu();
        for (const part of parts) part.visible = false;
        treeVisibilityChanged();
    } else hidePart(contextPart);
};
$('context-drawing').onclick = () => {
    const part = contextPart,
        multiple = highlightedGroup?.parts.size > 1;
    closePartMenu();
    if (part && model && !multiple) window.PartDrawing.open(part, model);
};
$('context-focus').onclick = () => {
    const parts = selectedParts();
    closePartMenu();
    if (!parts.length) return;
    const bounds = new THREE.Box3();
    for (const part of parts) bounds.union(new THREE.Box3().setFromObject(part));
    fit(null, bounds);
};
$('context-isolate').onclick = () => {
    const part = contextPart;
    closePartMenu();
    if (!model || !part) return;
    const parts = new Set(selectedParts());
    model.panels.forEach((panel) => {
        panel.visible = parts.has(panel);
    });
    model.hardware.visible = false;
    isolated = true;
    $('isolate-part').setAttribute('aria-pressed', 'true');
    $('show-all').disabled = false;
    renderPositionSearch();
    fit();
};
$('context-show-all').onclick = () => {
    closePartMenu();
    showAll();
};
document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('#part-menu')) closePartMenu();
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePartMenu();
});
for (const [name] of Object.entries(tabNames)) {
    $('tab-' + name).onclick = () => {
        if (mobileLayout.matches && activeTab === name && !$('app').classList.contains('panel-closed'))
            $('toggle-panel').click();
        else openTab(name);
    };
    $('tab-' + name).addEventListener('keydown', (event) => {
        const keys = Object.keys(tabNames).filter(
                (key) => !$('tab-' + key).hidden && getComputedStyle($('tab-' + key)).display !== 'none'
            ),
            index = keys.indexOf(name);
        let next = null;
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = keys[(index + 1) % keys.length];
        if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = keys[(index + keys.length - 1) % keys.length];
        if (event.key === 'Home') next = keys[0];
        if (event.key === 'End') next = keys[keys.length - 1];
        if (next) {
            event.preventDefault();
            openTab(next);
            $('tab-' + next).focus();
        }
    });
}
for (const color of swatches) {
    const button = document.createElement('button');
    button.style.setProperty('--swatch', color);
    button.title = color;
    button.setAttribute('aria-label', 'Цвет ' + color);
    button.disabled = true;
    button.onclick = () => applyColor(color);
    $('color-swatches').append(button);
}
$('material-color').oninput = (event) => applyColor(event.target.value);
$('material-glow').onchange = (event) => {
    for (const panel of lightTargets()) panel.userData.glow = event.target.checked;
    updateColorControls();
    render();
};
$('mode-light').onclick = () => setMaterialEditor('light');
$('choose-light-face').onclick = () => {
    choosingLightFace = !choosingLightFace;
    $('canvas').classList.toggle('choosing-light-face', choosingLightFace);
    $('light-status').textContent = choosingLightFace
        ? 'Нажмите на светящуюся грань профиля в модели. Esc - отмена.'
        : '';
};
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && choosingLightFace) {
        choosingLightFace = false;
        $('canvas').classList.remove('choosing-light-face');
        $('light-status').textContent = '';
    }
});
for (const key of ['color', 'power', 'distance'])
    $('light-' + key).oninput = () => {
        const settings = {
            color: $('light-color').value,
            power: Number($('light-power').value),
            distance: Number($('light-distance').value)
        };
        if (!Number.isFinite(settings.distance) || settings.distance < 50 || settings.distance > 10000) return;
        for (const panel of lightTargets()) panel.userData.light = { ...panel.userData.light, ...settings };
        $('light-power-value').textContent = mm(settings.power);
        render();
    };
$('color-hex').onchange = (event) => {
    let value = event.target.value.trim();
    if (!value.startsWith('#')) value = '#' + value;
    applyColor(value);
};
$('color-scope').onchange = updateColorControls;
$('reset-color').onclick = () => resetColors(false);
$('reset-all-colors').onclick = () => resetColors(true);
$('mode-color').onclick = () => {
    setMaterialEditor('color');
    updateColorControls();
    setMaterialEditor('color');
};
$('mode-texture').onclick = () => {
    setMaterialEditor('texture');
    updateColorControls();
    setMaterialEditor('texture');
};
$('load-texture').onclick = () => $('texture-input').click();
$('texture-input').onchange = (event) => {
    chooseTexture(event.target.files[0]);
    event.target.value = '';
};
$('texture-scale').onchange = changeTextureTransform;
$('texture-rotation').onchange = changeTextureTransform;
$('texture-mirror').onchange = changeTextureTransform;
$('texture-orientation').onchange = changeTextureTransform;
$('remove-texture').onclick = () => {
    textureOperation++;
    for (const panel of colorTargets()) assignTexture(panel, null);
    pruneTextureAssets();
    syncTextureControls();
    render();
    $('texture-status').textContent = 'Текстура снята. Для сохранения изменений обновите проект.';
};
$('undo-measure').onclick = () => {
    if (pendingPoint) {
        cancelPending();
        renderMeasurements();
        render();
        $('snap-status').textContent = 'Первая точка отменена. Выберите две точки.';
    } else removeMeasurement(measurements.length - 1);
};
$('clear-measures').onclick = () => {
    clearMeasurements();
    $('snap-status').textContent = 'Измерения очищены.';
};
$('toggle-panel').onclick = () => {
    const closed = $('app').classList.toggle('panel-closed');
    $('toggle-panel').setAttribute('aria-expanded', String(!closed));
    $('toggle-panel').setAttribute('aria-label', closed ? 'Открыть панель инструментов' : 'Скрыть панель инструментов');
    $('toggle-panel').title = closed ? 'Открыть панель' : 'Скрыть панель';
};
$('resize-panel').onclick = () => {
    const expanded = $('app').classList.toggle('panel-expanded');
    $('resize-panel').setAttribute('aria-expanded', String(expanded));
    $('resize-panel').setAttribute('aria-label', expanded ? 'Уменьшить панель' : 'Развернуть панель');
    $('resize-panel').title = expanded ? 'Уменьшить панель' : 'Развернуть панель';
};
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pendingPoint) {
        cancelPending();
        renderMeasurements();
        render();
        $('snap-status').textContent = 'Первая точка отменена.';
    }
});
$('canvas').addEventListener('keydown', (e) => {
    if (e.target.closest('button')) return;
    if (['+', '=', '-', '0'].includes(e.key)) {
        e.preventDefault();
        if (e.key === '0') fit();
        else zoom(e.key === '-' ? 1 / 1.2 : 1.2);
    }
});
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    $('canvas').classList.add('drop-target');
});
document.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
});
document.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
        dragDepth = 0;
        $('canvas').classList.remove('drop-target');
    }
});
document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('canvas').classList.remove('drop-target');
    addFiles(e.dataTransfer.files);
});
const mobileLayout = window.matchMedia('(max-width:700px), (max-width:1000px) and (pointer:coarse)');
function syncMobileViewport() {
    if (!mobileLayout.matches) return;
    const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    if (height) $('app').style.setProperty('--app-height', Math.round(height) + 'px');
    const keyboard = window.visualViewport && window.innerHeight - height > 120;
    $('app').classList.toggle('keyboard-open', Boolean(keyboard));
}
if (mobileLayout.matches) {
    $('toggle-panel').click();
    syncMobileViewport();
}
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncMobileViewport);
}
if (typeof window.addEventListener === 'function') window.addEventListener('resize', syncMobileViewport);
if (mobileLayout.addEventListener)
    mobileLayout.addEventListener('change', (event) => {
        if (event.matches) syncMobileViewport();
        else {
            $('app').style.removeProperty('--app-height');
            $('app').classList.remove('keyboard-open', 'panel-expanded');
        }
    });
syncRenderControls();

renderLocalFiles();
