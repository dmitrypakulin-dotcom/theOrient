(function (root) {
    'use strict';
    const T = root.THREE || (typeof require === 'function' ? require('./vendor/three.min.js') : null);
    function frame(panel) {
        const geometry = panel.geometry,
            positions = geometry.attributes.position;
        geometry.computeBoundingBox();
        const center = geometry.boundingBox.getCenter(new T.Vector3());
        const edges = new T.EdgesGeometry(geometry),
            points = edges.attributes.position;
        let axis = new T.Vector3(1, 0, 0),
            length = 0;
        for (let i = 0; i < points.count; i += 2) {
            const delta = new T.Vector3()
                .fromBufferAttribute(points, i + 1)
                .sub(new T.Vector3().fromBufferAttribute(points, i));
            if (delta.length() > length) {
                length = delta.length();
                axis.copy(delta).normalize();
            }
        }
        edges.dispose();
        const normals = geometry.attributes.normal;
        let normal = new T.Vector3(0, 0, 1),
            largest = 0;
        for (let i = 0; i < positions.count; i += 3) {
            const a = new T.Vector3().fromBufferAttribute(positions, i),
                b = new T.Vector3().fromBufferAttribute(positions, i + 1),
                c = new T.Vector3().fromBufferAttribute(positions, i + 2);
            const area = b.sub(a).cross(c.sub(a)).length();
            if (area > largest) {
                largest = area;
                normal.fromBufferAttribute(normals, i).normalize();
            }
        }
        return { center, axis, length, normal };
    }
    function emitter(panel) {
        const settings = panel.userData.light || { color: '#fff1d6', power: 1, distance: 1200 };
        if (!panel.userData.ledFrame) panel.userData.ledFrame = frame(panel);
        const saved = panel.userData.ledFrame;
        const f = {
            center: saved.center.clone(),
            axis: saved.axis.clone(),
            length: saved.length,
            normal: saved.normal.clone()
        };
        if (Array.isArray(settings.face)) {
            f.normal.fromArray(settings.face);
            if (panel.userData.localMatrix) f.normal.transformDirection(panel.userData.localMatrix);
        }
        const positions = panel.geometry.attributes.position;
        let extent = -Infinity;
        for (let i = 0; i < positions.count; i++)
            extent = Math.max(extent, new T.Vector3().fromBufferAttribute(positions, i).sub(f.center).dot(f.normal));
        f.center.addScaledVector(f.normal, extent + 0.7);
        return { ...f, panel, settings, color: new T.Color(settings.color).convertSRGBToLinear() };
    }
    function subdivide(panel) {
        const old = panel.geometry,
            attributes = old.attributes,
            positions = [],
            normals = [],
            uvs = [],
            bases = [],
            groups = [];
        const base = panel.userData.baseUV || attributes.uv.array;
        function vertex(i) {
            return {
                p: new T.Vector3().fromBufferAttribute(attributes.position, i),
                n: new T.Vector3().fromBufferAttribute(attributes.normal, i),
                uv: new T.Vector2().fromBufferAttribute(attributes.uv, i),
                base: new T.Vector2(base[i * 2], base[i * 2 + 1])
            };
        }
        function mid(a, b) {
            return {
                p: a.p.clone().add(b.p).multiplyScalar(0.5),
                n: a.n.clone().add(b.n).normalize(),
                uv: a.uv.clone().add(b.uv).multiplyScalar(0.5),
                base: a.base.clone().add(b.base).multiplyScalar(0.5)
            };
        }
        function triangle(a, b, c, depth) {
            if (depth < 4 && Math.max(a.p.distanceTo(b.p), b.p.distanceTo(c.p), c.p.distanceTo(a.p)) > 120) {
                const ab = mid(a, b),
                    bc = mid(b, c),
                    ca = mid(c, a);
                triangle(a, ab, ca, depth + 1);
                triangle(ab, b, bc, depth + 1);
                triangle(ca, bc, c, depth + 1);
                triangle(ab, bc, ca, depth + 1);
            } else
                for (const v of [a, b, c]) {
                    positions.push(v.p.x, v.p.y, v.p.z);
                    normals.push(v.n.x, v.n.y, v.n.z);
                    uvs.push(v.uv.x, v.uv.y);
                    bases.push(v.base.x, v.base.y);
                }
        }
        for (const group of old.groups.length
            ? old.groups
            : [{ start: 0, count: attributes.position.count, materialIndex: 0 }]) {
            const start = positions.length / 3;
            for (let i = group.start; i < group.start + group.count; i += 3)
                triangle(vertex(i), vertex(i + 1), vertex(i + 2), 0);
            groups.push({ start, count: positions.length / 3 - start, materialIndex: group.materialIndex });
        }
        const geometry = new T.BufferGeometry();
        geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('normal', new T.Float32BufferAttribute(normals, 3));
        geometry.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
        geometry.setAttribute('ledRadiance', new T.Float32BufferAttribute(new Float32Array(positions.length), 3));
        geometry.groups = groups;
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        panel.geometry = geometry;
        panel.userData.baseUV = new Float32Array(bases);
        panel.userData.sideUVRanges = groups
            .filter((g) => g.materialIndex === 1)
            .map((g) => ({ start: g.start, count: g.count }));
        delete panel.userData.snapFeatures;
        const material = panel.material;
        material.onBeforeCompile = (shader) => {
            shader.uniforms.ledFace = { value: new T.Vector3(0, 0, 1) };
            shader.uniforms.ledDirectional = { value: 0 };
            if (Array.isArray(panel.userData.light?.face)) {
                shader.uniforms.ledDirectional.value = 1;
                shader.uniforms.ledFace.value.fromArray(panel.userData.light.face);
                if (panel.userData.localMatrix)
                    shader.uniforms.ledFace.value.transformDirection(panel.userData.localMatrix);
            }
            material.userData.ledShader = shader;
            shader.vertexShader =
                'attribute vec3 ledRadiance; varying vec3 vLedRadiance; varying vec3 vLedSurfaceNormal;\n' +
                shader.vertexShader;
            shader.vertexShader = shader.vertexShader.replace(
                '#include <begin_vertex>',
                '#include <begin_vertex>\nvLedRadiance = ledRadiance; vLedSurfaceNormal = normal;'
            );
            shader.fragmentShader =
                'uniform vec3 ledFace; uniform float ledDirectional; varying vec3 vLedRadiance; varying vec3 vLedSurfaceNormal;\n' +
                shader.fragmentShader;
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <emissivemap_fragment>',
                '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= mix(1.0, step(0.95, dot(normalize(vLedSurfaceNormal), ledFace)), ledDirectional);'
            );
            shader.fragmentShader = shader.fragmentShader.replace(
                'gl_FragColor = vec4( outgoingLight, diffuseColor.a );',
                'outgoingLight += vLedRadiance * diffuseColor.rgb;\ngl_FragColor = vec4( outgoingLight, diffuseColor.a );'
            );
        };
        material.customProgramCacheKey = () => 'my-style-led-radiance-v1';
        material.needsUpdate = true;
        return old;
    }
    function tree(items) {
        if (!items.length) return null;
        const box = new T.Box3();
        items.forEach((item) => box.union(item.box));
        if (items.length <= 4) return { box, items };
        const size = box.getSize(new T.Vector3()),
            axis = size.x > size.y && size.x > size.z ? 'x' : size.y > size.z ? 'y' : 'z';
        items.sort((a, b) => a.box.min[axis] + a.box.max[axis] - b.box.min[axis] - b.box.max[axis]);
        const middle = Math.floor(items.length / 2);
        return { box, left: tree(items.slice(0, middle)), right: tree(items.slice(middle)) };
    }
    function blocked(node, ray, receiver, source) {
        if (!node) return false;
        const point = ray.ray.intersectBox(node.box, new T.Vector3());
        if (!node.box.containsPoint(ray.ray.origin) && (!point || point.distanceTo(ray.ray.origin) > ray.far + 0.1))
            return false;
        if (node.items)
            return node.items.some(
                (item) =>
                    item.panel !== receiver &&
                    item.panel !== source &&
                    ray.intersectObject(item.mesh).some((hit) => hit.distance < ray.far)
            );
        return blocked(node.left, ray, receiver, source) || blocked(node.right, ray, receiver, source);
    }
    function radiance(point, normal, receiver, sources, blockers) {
        const result = new T.Color(0, 0, 0),
            ray = new T.Raycaster();
        for (const source of sources) {
            if (source.panel === receiver || !source.settings.power) continue;
            const along = Math.max(
                -source.length / 2,
                Math.min(source.length / 2, point.clone().sub(source.center).dot(source.axis))
            );
            const target = source.center.clone().addScaledVector(source.axis, along);
            const delta = target.clone().sub(point),
                distance = delta.length();
            if (distance >= source.settings.distance || distance < 0.01) continue;
            delta.divideScalar(distance);
            const receiverCos = normal.dot(delta),
                emitterCos = -source.normal.dot(delta);
            if (receiverCos <= 0 || emitterCos <= 0) continue;
            const origin = point.clone().addScaledVector(normal, 0.3);
            const direction = target.clone().sub(origin),
                rayDistance = direction.length();
            ray.set(origin, direction.normalize());
            ray.near = 0.1;
            ray.far = Math.max(0.1, rayDistance - 0.5);
            if (blocked(blockers, ray, receiver, source.panel)) continue;
            const attenuation = Math.pow(1 - distance / source.settings.distance, 2);
            const strength = source.settings.power * 2.5 * receiverCos * Math.sqrt(emitterCos) * attenuation;
            result.r += source.color.r * strength;
            result.g += source.color.g * strength;
            result.b += source.color.b * strength;
        }
        return result;
    }
    class Baker {
        constructor(changed, status) {
            this.changed = changed;
            this.status = status;
            this.token = 0;
            this.signature = '';
            this.originals = new Map();
            this.model = null;
        }
        clear() {
            this.token++;
            this.signature = '';
            this.model = null;
            for (const geometry of this.originals.values()) geometry.dispose();
            this.originals.clear();
        }
        update(model, signature) {
            if (this.model === model && this.signature === signature) return;
            if (this.model !== model) this.clear();
            this.model = model;
            this.signature = signature;
            const token = ++this.token;
            if (!model) return;
            const sources = model.panels.filter((panel) => panel.visible && panel.userData.glow).map(emitter);
            if (!sources.length) {
                for (const panel of model.panels) {
                    const attr = panel.geometry.attributes.ledRadiance;
                    if (attr) {
                        attr.array.fill(0);
                        attr.needsUpdate = true;
                    }
                }
                this.status('');
                return;
            }
            const items = model.panels
                .filter((panel) => panel.visible && !panel.userData.glow)
                .map((panel) => {
                    const geometry = this.originals.get(panel) || panel.geometry;
                    geometry.computeBoundingBox();
                    const mesh = new T.Mesh(geometry, panel.material);
                    mesh.updateMatrixWorld();
                    return { panel, mesh, box: geometry.boundingBox.clone().expandByScalar(0.01) };
                });
            const blockers = tree(items);
            const run = async () => {
                this.status('Расчёт света от ' + sources.length + ' LED-профилей…');
                let last = performance.now();
                for (let index = 0; index < model.panels.length; index++) {
                    if (token !== this.token) return;
                    const panel = model.panels[index];
                    if (!panel.visible) continue;
                    if (!this.originals.has(panel)) this.originals.set(panel, subdivide(panel));
                    const geometry = panel.geometry,
                        p = geometry.attributes.position,
                        n = geometry.attributes.normal,
                        attr = geometry.attributes.ledRadiance;
                    const cache = new Map();
                    const bounds = geometry.boundingBox;
                    const nearby = sources.filter(
                        (source) => bounds.distanceToPoint(source.center) < source.settings.distance + source.length / 2
                    );
                    for (let i = 0; i < p.count; i++) {
                        if (token !== this.token) return;
                        const point = new T.Vector3().fromBufferAttribute(p, i),
                            normal = new T.Vector3().fromBufferAttribute(n, i).normalize();
                        const key = [point.x, point.y, point.z, normal.x, normal.y, normal.z]
                            .map((v) => Math.round(v * 100))
                            .join(',');
                        let color = cache.get(key);
                        if (!color) {
                            color = radiance(point, normal, panel, nearby, blockers);
                            cache.set(key, color);
                        }
                        attr.setXYZ(i, color.r, color.g, color.b);
                        if (performance.now() - last > 20) {
                            attr.needsUpdate = true;
                            await new Promise((resolve) => setTimeout(resolve, 0));
                            last = performance.now();
                        }
                    }
                    attr.needsUpdate = true;
                    if (index % 10 === 0) {
                        this.status('Расчёт LED: ' + Math.round(((index + 1) / model.panels.length) * 100) + '%');
                        this.changed();
                    }
                }
                if (token === this.token) {
                    this.status('');
                    this.changed();
                }
            };
            run().catch((error) => {
                if (token === this.token) this.status('Не удалось рассчитать LED: ' + error.message);
            });
        }
    }
    const api = { Baker, emitter, radiance, tree, subdivide };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.LEDLighting = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
