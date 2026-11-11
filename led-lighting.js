(function (root) {
    'use strict';
    
    // Подключаем Three.js (для работы в браузере или Node.js)
    const T = root.THREE || (typeof require === 'function' ? require('./vendor/three.min.js') : null);

    /**
     * Вычисляет "рамку" (frame) панели для LED-профиля.
     * Находит центр, самую длинную ось (вдоль которой идет профиль) и основную нормаль (куда светит).
     */
    function frame(panel) {
        const geometry = panel.geometry,
            positions = geometry.attributes.position;
        geometry.computeBoundingBox();
        const center = geometry.boundingBox.getCenter(new T.Vector3());
        
        // Ищем самое длинное ребро, чтобы определить ось профиля
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

        // Ищем самый большой треугольник, чтобы взять его нормаль (направление свечения)
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

    /**
     * Создает описание источника света (эмиттера) на основе данных панели.
     */
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
        
        // Если пользователь выбрал конкретную грань для свечения, используем её нормаль
        if (Array.isArray(settings.face)) {
            f.normal.fromArray(settings.face);
            if (panel.userData.localMatrix) f.normal.transformDirection(panel.userData.localMatrix);
        }
        
        // Смещаем центр света немного наружу от поверхности панели
        const positions = panel.geometry.attributes.position;
        let extent = -Infinity;
        for (let i = 0; i < positions.count; i++)
            extent = Math.max(extent, new T.Vector3().fromBufferAttribute(positions, i).sub(f.center).dot(f.normal));
        f.center.addScaledVector(f.normal, extent + 0.7);
        
        return { ...f, panel, settings, color: new T.Color(settings.color).convertSRGBToLinear() };
    }

    /**
     * Подразбиение (subdivision) геометрии.
     * Поскольку свет записывается в вершины, на больших плоских гранях (где всего 2 треугольника) 
     * свет выглядел бы как резкий градиент. Эта функция дробит большие треугольники на мелкие, 
     * чтобы свет распределялся плавно.
     * Также здесь внедряется кастомный шейдер для отображения подсветки.
     */
    function subdivide(panel) {
        const old = panel.geometry,
            attributes = old.attributes,
            positions = [],
            normals = [],
            uvs = [],
            bases = [],
            groups = [];
            
        const base = panel.userData.baseUV || attributes.uv.array;
        
        // Хелпер для извлечения данных вершины
        function vertex(i) {
            return {
                p: new T.Vector3().fromBufferAttribute(attributes.position, i),
                n: new T.Vector3().fromBufferAttribute(attributes.normal, i),
                uv: new T.Vector2().fromBufferAttribute(attributes.uv, i),
                base: new T.Vector2(base[i * 2], base[i * 2 + 1])
            };
        }
        
        // Хелпер для нахождения середины ребра
        function mid(a, b) {
            return {
                p: a.p.clone().add(b.p).multiplyScalar(0.5),
                n: a.n.clone().add(b.n).normalize(),
                uv: a.uv.clone().add(b.uv).multiplyScalar(0.5),
                base: a.base.clone().add(b.base).multiplyScalar(0.5)
            };
        }
        
        // Рекурсивное разбиение треугольника
        function triangle(a, b, c, depth) {
            // Если треугольник большой (длиннее 120мм) и глубина не превышена — делим его на 4 части
            if (depth < 4 && Math.max(a.p.distanceTo(b.p), b.p.distanceTo(c.p), c.p.distanceTo(a.p)) > 120) {
                const ab = mid(a, b),
                    bc = mid(b, c),
                    ca = mid(c, a);
                triangle(a, ab, ca, depth + 1);
                triangle(ab, b, bc, depth + 1);
                triangle(ca, bc, c, depth + 1);
                triangle(ab, bc, ca, depth + 1);
            } else {
                // Если треугольник достаточно мал, сохраняем его
                for (const v of [a, b, c]) {
                    positions.push(v.p.x, v.p.y, v.p.z);
                    normals.push(v.n.x, v.n.y, v.n.z);
                    uvs.push(v.uv.x, v.uv.y);
                    bases.push(v.base.x, v.base.y);
                }
            }
        }

        // Проходим по всем группам материалов и разбиваем треугольники
        for (const group of old.groups.length
            ? old.groups
            : [{ start: 0, count: attributes.position.count, materialIndex: 0 }]) {
            const start = positions.length / 3;
            for (let i = group.start; i < group.start + group.count; i += 3)
                triangle(vertex(i), vertex(i + 1), vertex(i + 2), 0);
            groups.push({ start, count: positions.length / 3 - start, materialIndex: group.materialIndex });
        }

        // Создаем новую геометрию с атрибутом ledRadiance (куда запишется свет)
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

        // Модификация шейдера материала
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
            
            // Внедряем атрибут ledRadiance в вершинный шейдер
            shader.vertexShader = 'attribute vec3 ledRadiance; varying vec3 vLedRadiance; varying vec3 vLedSurfaceNormal;\n' + shader.vertexShader;
            shader.vertexShader = shader.vertexShader.replace(
                '#include <begin_vertex>',
                '#include <begin_vertex>\nvLedRadiance = ledRadiance; vLedSurfaceNormal = normal;'
            );
            
            // Внедряем расчет света во фрагментный шейдер
            shader.fragmentShader = 'uniform vec3 ledFace; uniform float ledDirectional; varying vec3 vLedRadiance; varying vec3 vLedSurfaceNormal;\n' + shader.fragmentShader;
            
            // Учитываем направление грани (если выбрана конкретная грань)
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <emissivemap_fragment>',
                '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= mix(1.0, step(0.95, dot(normalize(vLedSurfaceNormal), ledFace)), ledDirectional);'
            );
            
            // Добавляем рассчитанный свет к финальному цвету
            shader.fragmentShader = shader.fragmentShader.replace(
                'gl_FragColor = vec4( outgoingLight, diffuseColor.a );',
                'outgoingLight += vLedRadiance * diffuseColor.rgb;\ngl_FragColor = vec4( outgoingLight, diffuseColor.a );'
            );
        };
        material.customProgramCacheKey = () => 'my-style-led-radiance-v1';
        material.needsUpdate = true;
        return old;
    }

    /**
     * Построение BVH-дерева (Bounding Volume Hierarchy) для быстрой проверки теней.
     * Вместо того чтобы проверять пересечение луча с каждой панелью, мы группируем их в коробки.
     */
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

    /**
     * Проверка, заблокирован ли луч другой панелью (находится ли панель в тени).
     */
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

    /**
     * Расчет количества света (radiance), падающего на конкретную точку.
     */
    function radiance(point, normal, receiver, sources, blockers) {
        const result = new T.Color(0, 0, 0),
            ray = new T.Raycaster();
            
        for (const source of sources) {
            if (source.panel === receiver || !source.settings.power) continue;
            
            // Находим ближайшую точку на источнике света
            const along = Math.max(
                -source.length / 2,
                Math.min(source.length / 2, point.clone().sub(source.center).dot(source.axis))
            );
            const target = source.center.clone().addScaledVector(source.axis, along);
            const delta = target.clone().sub(point),
                distance = delta.length();
                
            if (distance >= source.settings.distance || distance < 0.01) continue;
            delta.divideScalar(distance);
            
            // Закон косинусов Ламберта (угол падения света)
            const receiverCos = normal.dot(delta),
                emitterCos = -source.normal.dot(delta);
            if (receiverCos <= 0 || emitterCos <= 0) continue;
            
            // Проверка на перекрытие (тени)
            const origin = point.clone().addScaledVector(normal, 0.3);
            const direction = target.clone().sub(origin),
                rayDistance = direction.length();
            ray.set(origin, direction.normalize());
            ray.near = 0.1;
            ray.far = Math.max(0.1, rayDistance - 0.5);
            
            if (blocked(blockers, ray, receiver, source.panel)) continue;
            
            // Затухание света с расстоянием
            const attenuation = Math.pow(1 - distance / source.settings.distance, 2);
            const strength = source.settings.power * 2.5 * receiverCos * Math.sqrt(emitterCos) * attenuation;
            
            result.r += source.color.r * strength;
            result.g += source.color.g * strength;
            result.b += source.color.b * strength;
        }
        return result;
    }

    /**
     * Класс Baker (Запекатель) — управляет фоновым процессом расчета света.
     */
    class Baker {
        constructor(changed, status) {
            this.changed = changed;     // Колбэк для перерисовки
            this.status = status;       // Колбэк для обновления текста статуса
            this.token = 0;             // Токен для отмены устаревших расчетов
            this.signature = '';        // Хеш текущего состояния (чтобы не пересчитывать зря)
            this.originals = new Map(); // Кэш оригинальных геометрий (до подразбиения)
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
            
            // Находим все светящиеся панели (источники света)
            const sources = model.panels.filter((panel) => panel.visible && panel.userData.glow).map(emitter);
            
            if (!sources.length) {
                // Если источников нет, обнуляем свет на всех панелях
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

            // Строим дерево препятствий (для теней)
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

            // Асинхронный цикл расчета
            const run = async () => {
                this.status('Расчёт света от ' + sources.length + ' LED-профилей…');
                let last = performance.now();
                
                for (let index = 0; index < model.panels.length; index++) {
                    if (token !== this.token) return;
                    const panel = model.panels[index];
                    if (!panel.visible) continue;
                    
                    // Подразбиваем геометрию, если еще не делали этого
                    if (!this.originals.has(panel)) this.originals.set(panel, subdivide(panel));
                    
                    const geometry = panel.geometry,
                        p = geometry.attributes.position,
                        n = geometry.attributes.normal,
                        attr = geometry.attributes.ledRadiance;
                    const cache = new Map();
                    const bounds = geometry.boundingBox;
                    
                    // Отсекаем источники света, которые слишком далеко от этой панели
                    const nearby = sources.filter(
                        (source) => bounds.distanceToPoint(source.center) < source.settings.distance + source.length / 2
                    );
                    
                    // Проходим по всем вершинам панели и считаем для них свет
                    for (let i = 0; i < p.count; i++) {
                        if (token !== this.token) return;
                        
                        const point = new T.Vector3().fromBufferAttribute(p, i),
                            normal = new T.Vector3().fromBufferAttribute(n, i).normalize();
                            
                        // Кэшируем результаты для совпадающих вершин, чтобы не считать дважды
                        const key = [point.x, point.y, point.z, normal.x, normal.y, normal.z]
                            .map((v) => Math.round(v * 100))
                            .join(',');
                        let color = cache.get(key);
                        
                        if (!color) {
                            color = radiance(point, normal, panel, nearby, blockers);
                            cache.set(key, color);
                        }
                        
                        attr.setXYZ(i, color.r, color.g, color.b);
                        
                        // Раз в 20мс отдаем управление браузеру, чтобы интерфейс не завис
                        if (performance.now() - last > 20) {
                            attr.needsUpdate = true;
                            await new Promise((resolve) => setTimeout(resolve, 0));
                            last = performance.now();
                        }
                    }
                    
                    attr.needsUpdate = true;
                    
                    // Обновляем прогресс-бар
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
