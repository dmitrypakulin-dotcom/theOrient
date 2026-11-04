'use strict';
window.createSectionTools = function ({ getEngine, getModel, render }) {
    const $ = (id) => document.getElementById(id);
    let cut = { enabled: false, axis: 'x', position: 50, reverse: false };
    let plane = null,
        appliedModel = null;
    const materialSides = new WeakMap();
    let caps = null,
        capMaterial = null,
        capOutlineMaterial = null;
    function clearCaps() {
        if (!caps) return;
        if (caps.parent) caps.parent.remove(caps);
        caps.traverse((object) => {
            if (object.geometry) object.geometry.dispose();
        });
        caps = null;
    }
    function rebuildCaps(engine, model) {
        clearCaps();
        if (!plane || !window.SectionCaps) return;
        if (!capMaterial) {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 64;
            const context = canvas.getContext('2d');
            context.fillStyle = '#eadfc8';
            context.fillRect(0, 0, 64, 64);
            context.strokeStyle = '#ff2020';
            context.lineWidth = 3;
            for (let offset = -64; offset <= 64; offset += 32) {
                context.beginPath();
                context.moveTo(offset, 0);
                context.lineTo(offset + 64, 64);
                context.stroke();
            }
            const texture = new THREE.CanvasTexture(canvas);
            texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
            capMaterial = new THREE.MeshBasicMaterial({
                map: texture,
                side: THREE.DoubleSide,
                polygonOffset: true,
                polygonOffsetFactor: -1,
                polygonOffsetUnits: -1
            });
            capOutlineMaterial = new THREE.LineBasicMaterial({ color: 0xff0000, depthTest: true, depthWrite: false });
        }
        caps = new THREE.Group();
        for (const panel of model.panels) {
            const geometry = window.SectionCaps.geometry(panel.geometry, plane, THREE);
            if (!geometry.attributes.position.count) {
                geometry.dispose();
                continue;
            }
            const cap = new THREE.Mesh(geometry, capMaterial);
            cap.userData.source = panel;
            const outlineGeometry = new THREE.BufferGeometry();
            outlineGeometry.setAttribute(
                'position',
                new THREE.Float32BufferAttribute(geometry.userData.sectionOutline, 3)
            );
            const outline = new THREE.LineSegments(outlineGeometry, capOutlineMaterial);
            outline.renderOrder = 2;
            cap.add(outline);
            cap.visible = panel.visible;
            caps.add(cap);
        }
        engine.scene.add(caps);
    }
    function applyCut() {
        const engine = getEngine(),
            model = getModel();
        clearCaps();
        plane = null;
        appliedModel = model;
        if (!engine) return;
        engine.renderer.localClippingEnabled = true;
        if (model && cut.enabled) {
            const coordinate =
                model.bounds.min[cut.axis] +
                ((model.bounds.max[cut.axis] - model.bounds.min[cut.axis]) * cut.position) / 100;
            const normal = new THREE.Vector3();
            normal[cut.axis] = cut.reverse ? -1 : 1;
            plane = new THREE.Plane(normal, -coordinate * normal[cut.axis]);
        }
        if (model)
            for (const group of [model.group, model.hardware])
                group.traverse((object) => {
                    if (!object.material) return;
                    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
                        if (!materialSides.has(material)) materialSides.set(material, material.side);
                        material.clippingPlanes = plane ? [plane] : [];
                        material.clipShadows = true;
                        material.side = plane ? THREE.DoubleSide : materialSides.get(material);
                        material.needsUpdate = true;
                    }
                });
        if (model) rebuildCaps(engine, model);
    }
    function syncCut() {
        $('section-enabled').checked = cut.enabled;
        $('section-axis').value = cut.axis;
        $('section-position').value = cut.position;
        $('section-reverse').checked = cut.reverse;
        $('section-value').textContent = Math.round(cut.position) + '%';
        for (const id of ['section-axis', 'section-position', 'section-reverse']) $(id).disabled = !cut.enabled;
    }
    function isVisible(point) {
        return !plane || plane.distanceToPoint(point) >= -0.001;
    }
    function renderSection() {
        if (!getEngine()) return;
        if (getModel() !== appliedModel) applyCut();
        if (caps) for (const cap of caps.children) cap.visible = cap.userData.source.visible;
    }
    function reset() {
        cut = { enabled: false, axis: 'x', position: 50, reverse: false };
        applyCut();
        syncCut();
    }
    for (const id of ['section-enabled', 'section-axis', 'section-position', 'section-reverse'])
        $(id).addEventListener('input', () => {
            cut = {
                enabled: $('section-enabled').checked,
                axis: $('section-axis').value,
                position: Number($('section-position').value),
                reverse: $('section-reverse').checked
            };
            syncCut();
            applyCut();
            render();
        });

    syncCut();
    return { reset, isVisible, render: renderSection, state: () => ({ section: { ...cut } }) };
};
