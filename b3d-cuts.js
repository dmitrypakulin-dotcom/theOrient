(function (root) {
    'use strict';

    /**
     * Функция поиска внешних контуров (рёбер) геометрии.
     * Отсекает внутренние рёбра, которые появились из-за триангуляции плоских поверхностей,
     * оставляя только реальные границы детали.
     */
    function outlines(geometry, THREE) {
        const edges = new THREE.EdgesGeometry(geometry, 1),
            position = geometry.attributes.position,
            surfaces = [];
        geometry.computeBoundingBox();
        const tolerance = Math.max(0.0001, geometry.boundingBox.getSize(new THREE.Vector3()).length() * 3e-7);
        
        // Собираем все плоские поверхности (группируем треугольники по нормалям)
        for (let i = 0; i < position.count; i += 3) {
            const triangle = new THREE.Triangle(
                ...[0, 1, 2].map((j) => new THREE.Vector3().fromBufferAttribute(position, i + j))
            );
            if (triangle.getArea() < tolerance * tolerance) continue; // Пропускаем вырожденные треугольники
            const normal = triangle.getNormal(new THREE.Vector3());
            
            // Ищем уже существующую плоскость с такой же нормалью
            let surface = surfaces.find(
                (s) =>
                    Math.abs(s.normal.dot(normal)) > 0.999999 &&
                    Math.abs(s.normal.dot(triangle.a) + s.constant) < tolerance
            );
            if (!surface) {
                surface = { normal, constant: -normal.dot(triangle.a), triangles: [] };
                surfaces.push(surface);
            }
            surface.triangles.push(triangle);
        }

        const out = [],
            points = edges.attributes.position;
            
        // Проверяем каждое ребро: лежит ли оно на стыке двух треугольников одной плоскости (тогда оно внутреннее)
        for (let i = 0; i < points.count; i += 2) {
            const a = new THREE.Vector3().fromBufferAttribute(points, i),
                b = new THREE.Vector3().fromBufferAttribute(points, i + 1),
                mid = a.clone().add(b).multiplyScalar(0.5),
                direction = b.clone().sub(a).normalize();
                
            const internal = surfaces.some((surface) => {
                // Ребро должно лежать в этой плоскости и быть параллельно ей
                if (
                    Math.abs(surface.normal.dot(a) + surface.constant) > tolerance ||
                    Math.abs(surface.normal.dot(b) + surface.constant) > tolerance ||
                    Math.abs(surface.normal.dot(direction)) > 0.001
                )
                    return false;
                    
                // Смещаем точки влево и вправо от ребра, чтобы проверить, есть ли с обеих сторон треугольники
                const offset = surface.normal
                    .clone()
                    .cross(direction)
                    .multiplyScalar(Math.max(0.01, tolerance * 8));
                const plus = mid.clone().add(offset),
                    minus = mid.clone().sub(offset);
                    
                return (
                    surface.triangles.some((t) => t.containsPoint(plus)) &&
                    surface.triangles.some((t) => t.containsPoint(minus))
                );
            });
            
            // Если ребро внешнее (не внутреннее) — добавляем его в результат
            if (!internal) out.push(...a.toArray(), ...b.toArray());
        }
        
        edges.dispose();
        const result = new THREE.BufferGeometry();
        result.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
        return result;
    }

    /**
     * Функция "сшивания" (stitching).
     * Устраняет T-образные стыки (T-junctions), когда вершина одного треугольника лежит на ребре другого.
     * Это нужно, чтобы после обрезки (запила) в модели не появлялись визуальные щели.
     */
    function stitch(geometry, THREE) {
        geometry.computeBoundingBox();
        const tolerance = Math.max(1e-5, geometry.boundingBox.getSize(new THREE.Vector3()).length() * 2e-7),
            epsilon2 = tolerance * tolerance;
            
        const position = geometry.attributes.position,
            uv = geometry.attributes.uv,
            points = [],
            vertices = [];
            
        // Собираем все уникальные вершины (объединяем близкие точки)
        for (let i = 0; i < position.count; i++) {
            const point = new THREE.Vector3().fromBufferAttribute(position, i);
            let shared = points.find((p) => p.distanceToSquared(point) < epsilon2);
            if (!shared) {
                shared = point;
                points.push(shared);
            }
            vertices.push({ p: shared, uv: new THREE.Vector2().fromBufferAttribute(uv, i) });
        }

        const positions = [],
            textures = [],
            result = new THREE.BufferGeometry();
            
        const append = (triangle) => {
            // Пропускаем треугольники с нулевой площадью
            if (
                triangle[1].p.clone().sub(triangle[0].p).cross(triangle[2].p.clone().sub(triangle[0].p)).lengthSq() <
                epsilon2 * epsilon2
            )
                return;
            for (const v of triangle) {
                positions.push(...v.p.toArray());
                textures.push(v.uv.x, v.uv.y);
            }
        };

        // Проходим по всем треугольникам
        for (const group of geometry.groups) {
            const start = positions.length / 3;
            for (let i = group.start; i < group.start + group.count; i += 3) {
                const triangle = vertices.slice(i, i + 3),
                    boundary = [];
                    
                // Проверяем каждое ребро треугольника на наличие промежуточных вершин
                for (let j = 0; j < 3; j++) {
                    const a = triangle[j],
                        b = triangle[(j + 1) % 3],
                        delta = b.p.clone().sub(a.p),
                        length2 = delta.lengthSq(),
                        inside = [];
                    boundary.push(a);
                    if (length2 <= epsilon2) continue;
                    
                    const margin = tolerance / Math.sqrt(length2);
                    // Ищем вершины, которые лежат прямо на этом ребре
                    for (const p of points) {
                        const t = p.clone().sub(a.p).dot(delta) / length2;
                        if (
                            t > margin &&
                            t < 1 - margin &&
                            a.p.clone().addScaledVector(delta, t).distanceToSquared(p) < epsilon2
                        )
                            inside.push({ t, p });
                    }
                    
                    // Сортируем их по порядку и добавляем в контур (с интерполяцией UV-координат)
                    inside.sort((a, b) => a.t - b.t);
                    for (const value of inside) boundary.push({ p: value.p, uv: a.uv.clone().lerp(b.uv, value.t) });
                }
                
                // Если промежуточных вершин нет — оставляем треугольник как есть
                if (boundary.length === 3) append(triangle);
                else {
                    // Если есть T-стыки, "веером" пересобираем треугольник из центра
                    const center = {
                        p: triangle.reduce((p, v) => p.add(v.p), new THREE.Vector3()).multiplyScalar(1 / 3),
                        uv: triangle.reduce((p, v) => p.add(v.uv), new THREE.Vector2()).multiplyScalar(1 / 3)
                    };
                    for (let j = 0; j < boundary.length; j++)
                        append([center, boundary[j], boundary[(j + 1) % boundary.length]]);
                }
            }
            result.addGroup(start, positions.length / 3 - start, group.materialIndex);
        }
        
        result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        result.setAttribute('uv', new THREE.Float32BufferAttribute(textures, 2));
        result.computeVertexNormals();
        return result;
    }

    /**
     * Функция обрезки (запила) по плоскости.
     * Отсекает часть геометрии, которая находится ниже (или выше) плоскости, и "зашивает" торец.
     */
    function clip(geometry, plane, along, THREE) {
        const positions = geometry.attributes.position,
            uv = geometry.attributes.uv;
        const buckets = [[], []], // Треугольники до и после обрезки
            segments = [],       // Линии разреза
            epsilon = 1e-5;
            
        const value = (i) => ({
            p: new THREE.Vector3().fromBufferAttribute(positions, i),
            uv: new THREE.Vector2().fromBufferAttribute(uv, i)
        });
        
        const groups = geometry.groups.length
            ? geometry.groups
            : [{ start: 0, count: positions.count, materialIndex: 0 }];
            
        const unique = (list) =>
            list.filter(
                (v, i) => !list.slice(0, i).some((other) => other.p.distanceToSquared(v.p) < epsilon * epsilon)
            );

        // Проходим по всем треугольникам и отсекаем их плоскостью
        for (const group of groups)
            for (let i = group.start; i < group.start + group.count; i += 3) {
                const triangle = [value(i), value(i + 1), value(i + 2)],
                    polygon = [];
                    
                for (let j = 0; j < 3; j++) {
                    const a = triangle[j],
                        b = triangle[(j + 1) % 3],
                        da = plane.distanceToPoint(a.p),
                        db = plane.distanceToPoint(b.p);
                    if (da >= -epsilon) polygon.push(a);
                    // Если ребро пересекает плоскость, находим точку пересечения
                    if ((da > epsilon && db < -epsilon) || (da < -epsilon && db > epsilon)) {
                        const t = da / (da - db);
                        polygon.push({ p: a.p.clone().lerp(b.p, t), uv: a.uv.clone().lerp(b.uv, t) });
                    }
                }
                
                const vertices = unique(polygon);
                // Собираем линии отреза для "зашивания" торца
                if (triangle.some((v) => plane.distanceToPoint(v.p) < -epsilon)) {
                    const boundary = vertices.filter((v) => Math.abs(plane.distanceToPoint(v.p)) < epsilon * 2);
                    if (boundary.length === 2) segments.push(boundary.map((v) => v.p));
                }
                // Распределяем оставшиеся части по группам материалов
                for (let j = 1; j < vertices.length - 1; j++)
                    buckets[group.materialIndex === 1 ? 1 : 0].push([vertices[0], vertices[j], vertices[j + 1]]);
            }

        // Формируем замкнутые контуры из линий отреза
        const key = (p) => [p.x, p.y, p.z].map((n) => Math.round(n * 10000)).join(',');
        const nodes = new Map(),
            edges = new Map();
        for (const [a, b] of segments) {
            const ka = key(a),
                kb = key(b);
            if (ka === kb) continue;
            nodes.set(ka, a);
            nodes.set(kb, b);
            const id = [ka, kb].sort().join('|');
            edges.set(id, [ka, kb]);
        }
        
        const adjacency = new Map();
        for (const [id, pair] of edges)
            for (const k of pair) {
                if (!adjacency.has(k)) adjacency.set(k, []);
                adjacency.get(k).push(id);
            }
            
        const loops = [];
        while (edges.size) {
            const [firstId, first] = edges.entries().next().value;
            edges.delete(firstId);
            const loop = [first[0], first[1]];
            let current = first[1];
            while (current !== loop[0]) {
                const nextId = (adjacency.get(current) || []).find((id) => edges.has(id));
                if (!nextId) break;
                const pair = edges.get(nextId);
                edges.delete(nextId);
                current = pair[0] === current ? pair[1] : pair[0];
                loop.push(current);
            }
            if (current === loop[0] && loop.length >= 4) loops.push(loop.slice(0, -1).map((k) => nodes.get(k)));
        }

        // Проецируем контуры на плоскость и триангулируем (зашиваем торец)
        const u = along.clone().normalize(),
            v = plane.normal.clone().cross(u).normalize();
        const loops2 = loops.map((loop) => loop.map((p) => new THREE.Vector2(p.dot(u), p.dot(v))));
        
        const inside = (p, loop) => {
            let result = false;
            for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
                const a = loop[i],
                    b = loop[j];
                if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) result = !result;
            }
            return result;
        };
        
        const depth = loops2.map((loop, i) => loops2.filter((other, j) => i !== j && inside(loop[0], other)).length);
        
        for (let i = 0; i < loops.length; i++) {
            if (depth[i] % 2) continue;
            const holes = loops2
                .map((loop, j) => ({ loop, j }))
                .filter(({ loop, j }) => depth[j] === depth[i] + 1 && inside(loop[0], loops2[i]));
            const points = loops[i].concat(...holes.map((h) => loops[h.j]));
            const coords = loops2[i].concat(...holes.map((h) => h.loop));
            
            for (const ids of THREE.ShapeUtils.triangulateShape(
                loops2[i].slice(),
                holes.map((h) => h.loop.slice())
            )) {
                const triangle = ids.map((index) => ({ p: points[index], uv: coords[index] }));
                const normal = triangle[1].p.clone().sub(triangle[0].p).cross(triangle[2].p.clone().sub(triangle[0].p));
                if (normal.dot(plane.normal) > 0) [triangle[1], triangle[2]] = [triangle[2], triangle[1]];
                buckets[1].push(triangle);
            }
        }

        const p = [],
            t = [],
            result = new THREE.BufferGeometry();
            
        for (let material = 0; material < 2; material++) {
            const start = p.length / 3;
            for (const triangle of buckets[material])
                for (const vertex of triangle) {
                    p.push(...vertex.p.toArray());
                    t.push(vertex.uv.x, vertex.uv.y);
                }
            result.addGroup(start, p.length / 3 - start, material);
        }
        
        if (!p.length) {
            result.dispose();
            throw new Error('Запил удаляет всю деталь');
        }
        result.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
        result.setAttribute('uv', new THREE.Float32BufferAttribute(t, 2));
        result.computeVertexNormals();
        return result;
    }

    /**
     * Вычитание 3D-призмы (паза, фрезеровки) из основной геометрии.
     * Использует CSG (Constructive Solid Geometry) на основе BSP-дерева.
     */
    function subtractPrism(geometry, section, path, THREE) {
        const epsilon = 1e-5;
        const vertex = (p, uv) => ({ p, uv });
        const cloneVertex = (v) => vertex(v.p.clone(), v.uv.clone());
        
        function polygon(vertices, material = 1) {
            const normal = vertices[1].p
                .clone()
                .sub(vertices[0].p)
                .cross(vertices[2].p.clone().sub(vertices[0].p))
                .normalize();
            return { vertices, normal, w: normal.dot(vertices[0].p), material };
        }
        function flip(p) {
            p.vertices.reverse();
            p.normal.negate();
            p.w = -p.w;
        }
        
        // Разделение полигона плоскостью на переднюю и заднюю части
        function split(plane, poly, coplanarFront, coplanarBack, front, back) {
            const types = poly.vertices.map((v) => {
                const d = plane.normal.dot(v.p) - plane.w;
                return d < -epsilon ? 2 : d > epsilon ? 1 : 0;
            });
            const type = types.reduce((a, b) => a | b, 0);
            if (!type) (plane.normal.dot(poly.normal) > 0 ? coplanarFront : coplanarBack).push(poly);
            else if (type === 1) front.push(poly);
            else if (type === 2) back.push(poly);
            else {
                const f = [], b = [];
                for (let i = 0; i < poly.vertices.length; i++) {
                    const j = (i + 1) % poly.vertices.length,
                        a = poly.vertices[i],
                        z = poly.vertices[j];
                    if (types[i] !== 2) f.push(cloneVertex(a));
                    if (types[i] !== 1) b.push(cloneVertex(a));
                    if ((types[i] | types[j]) === 3) {
                        const t = (plane.w - plane.normal.dot(a.p)) / plane.normal.dot(z.p.clone().sub(a.p));
                        const v = vertex(a.p.clone().lerp(z.p, t), a.uv.clone().lerp(z.uv, t));
                        f.push(v);
                        b.push(cloneVertex(v));
                    }
                }
                if (f.length >= 3) front.push(polygon(f, poly.material));
                if (b.length >= 3) back.push(polygon(b, poly.material));
            }
        }

        // Узел BSP-дерева для булевых операций
        class Node {
            constructor(polys = []) {
                this.polys = [];
                this.plane = null;
                this.front = null;
                this.back = null;
                this.build(polys);
            }
            build(polys) {
                if (!polys.length) return;
                if (!this.plane) this.plane = { normal: polys[0].normal.clone(), w: polys[0].w };
                const f = [], b = [];
                for (const p of polys) split(this.plane, p, this.polys, this.polys, f, b);
                if (f.length) {
                    if (!this.front) this.front = new Node();
                    this.front.build(f);
                }
                if (b.length) {
                    if (!this.back) this.back = new Node();
                    this.back.build(b);
                }
            }
            invert() {
                this.polys.forEach(flip);
                if (this.plane) {
                    this.plane.normal.negate();
                    this.plane.w = -this.plane.w;
                }
                if (this.front) this.front.invert();
                if (this.back) this.back.invert();
                [this.front, this.back] = [this.back, this.front];
            }
            clip(polys) {
                if (!this.plane) return polys.slice();
                let f = [], b = [];
                for (const p of polys) split(this.plane, p, f, b, f, b);
                if (this.front) f = this.front.clip(f);
                b = this.back ? this.back.clip(b) : [];
                return f.concat(b);
            }
            clipTo(node) {
                this.polys = node.clip(this.polys);
                if (this.front) this.front.clipTo(node);
                if (this.back) this.back.clipTo(node);
            }
            all() {
                return this.polys.concat(this.front ? this.front.all() : [], this.back ? this.back.all() : []);
            }
        }

        // Преобразование Three.js Geometry в полигоны для BSP
        function polygons(g, cutter = false) {
            const p = g.attributes.position,
                uv = g.attributes.uv,
                index = g.index,
                result = [];
            for (let i = 0, count = index ? index.count : p.count; i < count; i += 3) {
                const vs = [0, 1, 2].map((j) => {
                    const k = index ? index.getX(i + j) : i + j;
                    return vertex(
                        new THREE.Vector3().fromBufferAttribute(p, k),
                        new THREE.Vector2().fromBufferAttribute(uv, k)
                    );
                });
                const group = g.groups.find((group) => i >= group.start && i < group.start + group.count);
                if (new THREE.Triangle(...vs.map((v) => v.p)).getArea() > epsilon * epsilon)
                    result.push(polygon(vs, cutter ? 1 : group?.materialIndex || 0));
            }
            return result;
        }

        const start = new THREE.Vector2(...path[0]),
            end = new THREE.Vector2(...path[1]),
            direction = end.clone().sub(start),
            length = direction.length();
        if (length < epsilon) throw new Error('Пустая траектория паза');
        direction.normalize();
        
        const left = new THREE.Vector2(-direction.y, direction.x);
        const shape = new THREE.Shape(section.map((p) => new THREE.Vector2(...p)));
        
        // Создаем "фрезу" (выдавливаем профиль вдоль траектории)
        const cutter = new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false, steps: 1 });
        cutter.applyMatrix4(
            new THREE.Matrix4().set(
                left.x, 0, direction.x, start.x,
                left.y, 0, direction.y, start.y,
                0, 1, 0, 0,
                0, 0, 0, 1
            )
        );

        // Выполняем CSG-вычитание: деталь минус фреза
        const a = new Node(polygons(geometry)),
            b = new Node(polygons(cutter, true));
        cutter.dispose();
        a.invert();
        a.clipTo(b);
        b.clipTo(a);
        b.invert();
        b.clipTo(a);
        b.invert();
        a.build(b.all());
        a.invert();

        // Собираем результат обратно в BufferGeometry
        const positions = [],
            textures = [];
        const result = new THREE.BufferGeometry();
        const all = a.all();
        for (let material = 0; material < 2; material++) {
            const start = positions.length / 3;
            for (const p of all.filter((p) => p.material === material))
                for (let i = 1; i < p.vertices.length - 1; i++)
                    for (const v of [p.vertices[0], p.vertices[i], p.vertices[i + 1]]) {
                        positions.push(...v.p.toArray());
                        textures.push(v.uv.x, v.uv.y);
                    }
            result.addGroup(start, positions.length / 3 - start, material);
        }
        result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        result.setAttribute('uv', new THREE.Float32BufferAttribute(textures, 2));
        result.computeVertexNormals();
        return result;
    }

    /**
     * Главная функция, которая читает данные о резах из B3D и применяет их к геометрии.
     */
    function apply(geometry, fields, panelLoops, get, contour, THREE) {
        const warnings = [];
        let count = 0;
        
        // Перебираем все операции реза (Cuts)
        for (const entry of get(fields, 'Cuts', [])) {
            if (entry.name !== 'Cut' || !Array.isArray(entry.value)) continue;
            const cut = entry.value,
                params = get(cut, 'Params', []);
            const kind = get(params, 'typ');
            if (![1, 2, 3, 4].includes(kind)) continue;
            
            try {
                const sections = contour(get(cut, 'Contour')), // Профиль реза
                    paths = contour(get(cut, 'Trajectory'), true); // Траектория (для пазов)
                    
                // Типы 1, 2, 3 — это пазы/фрезеровка (вычитание призмы)
                if (kind !== 4) {
                    if (sections.length !== 1 || paths.length !== 1 || paths[0].length !== 2)
                        throw new Error('Неподдерживаемая траектория паза');
                    const next = subtractPrism(geometry, sections[0], paths[0], THREE);
                    geometry.dispose();
                    geometry = next;
                    count++;
                    continue;
                }
                
                // Тип 4 — это запил (отрезание части панели под углом)
                if (sections.length !== 1 || sections[0].length !== 3 || paths.length !== 1 || paths[0].length !== 2)
                    throw new Error('Неподдерживаемый профиль или траектория запила');
                    
                const section = sections[0],
                    path = paths[0],
                    dx = path[1][0] - path[0][0],
                    dy = path[1][1] - path[0][1],
                    length = Math.hypot(dx, dy);
                if (length < 0.001) throw new Error('Пустая траектория запила');
                
                const along = new THREE.Vector3(dx / length, dy / length, 0),
                    left = new THREE.Vector2(-dy / length, dx / length);

                // Проверяем, что запил проходит по всему торцу панели
                const coversEdge = panelLoops.some((loop) =>
                    loop.some((a, i) => {
                        const b = loop[(i + 1) % loop.length];
                        const distance = (p) => Math.abs((p[0] - path[0][0]) * left.x + (p[1] - path[0][1]) * left.y);
                        const projection = (p) => (p[0] - path[0][0]) * along.x + (p[1] - path[0][1]) * along.y;
                        return (
                            distance(a) < 0.05 &&
                            distance(b) < 0.05 &&
                            Math.min(projection(a), projection(b)) >= -0.05 &&
                            Math.max(projection(a), projection(b)) <= length + 0.05
                        );
                    })
                );
                if (!coversEdge) throw new Error('Запил не охватывает целый торец');
                if (
                    !panelLoops.every((loop) =>
                        loop.every((p) => {
                            const t = (p[0] - path[0][0]) * along.x + (p[1] - path[0][1]) * along.y;
                            return t >= -0.05 && t <= length + 0.05;
                        })
                    )
                )
                    throw new Error('Частичный запил требует конечного выреза');

                // Вычисляем плоскость реза по диагонали треугольного профиля
                const diagonal = section
                    .map((a, i) => [a, section[(i + 1) % 3]])
                    .find(([a, b]) => Math.abs(a[0] - b[0]) > 0.001 && Math.abs(a[1] - b[1]) > 0.001);
                if (!diagonal) throw new Error('Не найдена наклонная плоскость запила');
                
                const [a, b] = diagonal,
                    normal = new THREE.Vector2(b[1] - a[1], a[0] - b[0]).normalize();
                let offset = -normal.x * a[0] - normal.y * a[1];
                
                // Проверяем направление плоскости (чтобы отрезать правильную часть)
                const center = section
                    .reduce((p, c) => p.add(new THREE.Vector2(...c)), new THREE.Vector2())
                    .multiplyScalar(1 / 3);
                if (normal.dot(center) + offset > 0) {
                    normal.negate();
                    offset = -offset;
                }
                
                const plane = new THREE.Plane(
                    new THREE.Vector3(left.x * normal.x, left.y * normal.x, normal.y),
                    offset - normal.x * (left.x * path[0][0] + left.y * path[0][1])
                );
                
                const next = clip(geometry, plane, along, THREE);
                geometry.dispose();
                geometry = next;
                count++;
            } catch (error) {
                warnings.push(error.message);
            }
        }
        
        // Если были резы, делаем "сшивание" (убираем T-стыки)
        if (count) {
            const joined = stitch(geometry, THREE);
            geometry.dispose();
            geometry = joined;
        }
        
        return { geometry, count, warnings };
    }

    const api = { clip, apply, stitch, outlines };
    root.BazisCuts = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
