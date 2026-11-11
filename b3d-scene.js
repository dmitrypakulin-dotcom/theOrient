(function (root) {
    'use strict';

    /**
     * Главная функция сборки 3D-сцены из распарсенных данных B3D.
     */
    function build(parsed, THREE) {
        const { get, contour } = root.BazisB3D || require('./b3d-parser.js');
        const cuts = root.BazisCuts || (typeof require === 'function' ? require('./b3d-cuts.js') : null);
        const hardwareCodec =
            root.BazisHardware || (typeof require === 'function' ? require('./b3d-hardware.js') : null);

        // Кэши и массивы для собираемых объектов
        const hardwareTemplates = new Map(), // Шаблоны геометрии фурнитуры по FastID
            hardwareMeshes = [],            // 3D-меши фурнитуры
            revolvedMeshes = [];            // Тела вращения
            
        const group = new THREE.Group(),      // Корневая группа всей сцены
            hardware = new THREE.Group(),     // Отдельная группа для контуров фурнитуры
            panels = [],                      // Массив всех панелей
            warnings = [];                    // Предупреждения при сборке
            
        const tree = [],                      // Дерево модели
            treeNodes = new Map(),            // Карта узлов дерева
            drillings = [];                   // Массив отверстий (для чертежей)
            
        let treeSequence = 0;

        // Статистика сборки
        const stats = {
            panels: 0, hardware: 0, hardwareMeshes: 0, hardwareTriangles: 0,
            service: 0, unsupported: 0, layered: 0, bevels: 0
        };

        // Справочник фурнитуры (FastID -> поля)
        const fittings = new Map(
            get(parsed.document || [], 'FurnList', []).map((n) => [get(n.value, 'FastID'), n.value])
        );

        // Утилита для получения Vector3 из полей
        const vector = (fields, keys) => new THREE.Vector3(...keys.map((key) => get(fields, key, 0)));

        // ==========================================
        // 1. ГЕНЕРАЦИЯ ГЕОМЕТРИИ ПОГОНАЖА (ПРОТЯЖКИ)
        // ==========================================
        /**
         * Создает 3D-тело, вытягивая 2D-профиль вдоль заданной траектории (type 2001).
         */
        function sweepGeometry(profileLoops, trajectory) {
            const positions = [], uvs = [], caps = [], sides = [];
            
            for (const path of contour(trajectory, true)) {
                const closed = Math.hypot(path[0][0] - path[path.length - 1][0], path[0][1] - path[path.length - 1][1]) < 0.01;
                const distances = [0];
                for (let i = 1; i < path.length; i++)
                    distances[i] = distances[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
                    
                for (const sourceLoop of profileLoops) {
                    // Выравниваем обмотку профиля
                    const loop = THREE.ShapeUtils.isClockWise(sourceLoop.map((p) => new THREE.Vector2(...p)))
                        ? sourceLoop
                        : sourceLoop.slice().reverse();
                        
                    // Строим "кольца" из точек профиля вдоль траектории
                    const rings = path.map((point, index) => {
                        const before = closed && (index === 0 || index === path.length - 1) ? path[path.length - 2] : path[Math.max(0, index - 1)],
                            after = closed && (index === 0 || index === path.length - 1) ? path[1] : path[Math.min(path.length - 1, index + 1)];
                        const a = new THREE.Vector2(point[0] - before[0], point[1] - before[1]).normalize();
                        const b = new THREE.Vector2(after[0] - point[0], after[1] - point[1]).normalize();
                        
                        if (!closed && index === 0) a.copy(b);
                        if (!closed && index === path.length - 1) b.copy(a);
                        
                        // Вычисляем нормаль с учетом угла поворота (Miter joint)
                        const first = new THREE.Vector2(-a.y, a.x),
                            second = new THREE.Vector2(-b.y, b.x);
                        const normal = first.clone().add(second).normalize();
                        const miter = 1 / Math.max(0.1, normal.dot(first));
                        
                        return loop.map(
                            (p) => new THREE.Vector3(
                                point[0] + normal.x * p[0] * miter,
                                point[1] + normal.y * p[0] * miter,
                                p[1]
                            )
                        );
                    });

                    // Торцы (заглушки) для незамкнутых траекторий
                    const triangles = THREE.ShapeUtils.triangulateShape(loop.map((p) => new THREE.Vector2(...p)), []);
                    for (const triangle of closed ? [] : triangles) {
                        caps.push(triangle.slice().reverse().map((i) => ({ p: rings[0][i], uv: loop[i] })));
                        caps.push(triangle.map((i) => ({ p: rings[rings.length - 1][i], uv: loop[i] })));
                    }

                    // Боковые стенки
                    for (let i = 0; i < path.length - 1; i++) {
                        let perimeter = 0;
                        for (let j = 0; j < loop.length; j++) {
                            const k = (j + 1) % loop.length,
                                next = perimeter + Math.hypot(loop[k][0] - loop[j][0], loop[k][1] - loop[j][1]);
                            const a = { p: rings[i][j], uv: [distances[i], perimeter] },
                                b = { p: rings[i + 1][j], uv: [distances[i + 1], perimeter] },
                                c = { p: rings[i + 1][k], uv: [distances[i + 1], next] },
                                d = { p: rings[i][k], uv: [distances[i], next] };
                            sides.push([a, b, d], [b, c, d]);
                            perimeter = next;
                        }
                    }
                }
            }
            
            const append = (triangles) => {
                for (const triangle of triangles)
                    for (const vertex of triangle) {
                        positions.push(...vertex.p.toArray());
                        uvs.push(...vertex.uv);
                    }
            };
            
            append(caps);
            const capCount = positions.length / 3;
            append(sides);
            
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
            geometry.addGroup(0, capCount, 0);
            geometry.addGroup(capCount, positions.length / 3 - capCount, 1);
            geometry.computeVertexNormals();
            return geometry;
        }

        // ==========================================
        // 2. РЕКУРСИВНЫЙ ОБХОД СЦЕНЫ B3D
        // ==========================================
        function visit(nodes, parent, continuation = false, treeChildren = tree) {
            for (const node of nodes) {
                if (!Array.isArray(node.value)) continue;
                if (node.name !== 'Obj') {
                    visit(node.value, parent, continuation, treeChildren);
                    continue;
                }

                const continued = continuation || node.continuation === true;
                const legacyTail = Number.isFinite(parsed.legacySceneBoundary) && node.sourceOffset >= parsed.legacySceneBoundary;
                
                const fields = node.value,
                    trans = get(fields, 'Trans', []),
                    type = get(fields, 'Type');
                    
                // Мировая матрица для детали
                const pos = vector(trans, ['X', 'Y', 'Z']);
                const quat = new THREE.Quaternion(
                    get(trans, 'Rx', 0), get(trans, 'Ry', 0), get(trans, 'Rz', 0), get(trans, 'Rw', 1)
                ).normalize();
                const matrix = new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(1, 1, 1)).premultiply(parent);
                
                const name = get(fields, 'Name', 'Деталь');

                // Создаем узел дерева
                const treeNode = {
                    id: 'object-' + treeSequence++,
                    name: String(name || 'Деталь'),
                    type,
                    children: [],
                    ownIndices: [],
                    indices: []
                };
                treeChildren.push(treeNode);
                treeNodes.set(treeNode.id, treeNode);

                const data = get(fields, 'Contour'),
                    signedThickness = get(fields, 'Thick', get(fields, 'Thickness'));
                const trajectory = type === 2001 ? get(fields, 'Trajectory') : null;
                const revolution = type === 2002;
                let baseThickness = Math.abs(signedThickness);

                // ==========================================
                // 2.1 ОБРАБОТКА ПАНЕЛЕЙ (И ПРОФИЛЕЙ)
                // ==========================================
                if (data && (baseThickness > 0 || trajectory || revolution)) {
                    try {
                        const loops = contour(data);
                        if (!loops.length) throw new Error('Пустой контур');
                        
                        if (trajectory) { /* ... вычисление толщины ... */ }
                        if (revolution) { /* ... вычисление толщины ... */ }

                        let low = signedThickness < 0 ? -baseThickness : 0,
                            high = signedThickness < 0 ? 0 : baseThickness;

                        // Сбор слоев (основа + пластик)
                        const layers = [{
                            name: 'Основа', materialName: get(fields, 'Mat', ''),
                            thickness: baseThickness, side: 'core', min: low, max: high
                        }];
                        
                        for (const entry of get(fields, 'Plastics', [])) {
                            // ... логика добавления слоев ...
                        }
                        layers.sort((a, b) => a.min - b.min);
                        const thickness = high - low;

                        // Функция проверки точки внутри полигона
                        const inside = (point, loop) => { /* ... */ };
                        
                        // Считаем вложенность (определяем отверстия)
                        const depth = loops.map((loop, i) => loops.filter((other, j) => j !== i && inside(loop[0], other)).length);
                        
                        // ==========================================
                        // ВАШЕ ИСПРАВЛЕНИЕ: ПРИНУДИТЕЛЬНАЯ ОБМОТКА КОНТУРОВ
                        // ==========================================
                        const shapes = [];
                        loops.forEach((loop, i) => {
                            if (depth[i] % 2) return; // Пропускаем отверстия
                            
                            // 1. Внешний контур (должен быть CCW - против часовой)
                            const shapePoints = loop.map((p) => new THREE.Vector2(...p));
                            if (THREE.ShapeUtils.isClockWise(shapePoints)) shapePoints.reverse();
                            const shape = new THREE.Shape(shapePoints);
                            
                            // 2. Отверстия (должны быть CW - по часовой)
                            loops.forEach((hole, j) => {
                                if (depth[j] === depth[i] + 1 && inside(hole[0], loop)) {
                                    const holePoints = hole.map((p) => new THREE.Vector2(...p));
                                    if (!THREE.ShapeUtils.isClockWise(holePoints)) holePoints.reverse();
                                    shape.holes.push(new THREE.Path(holePoints));
                                }
                            });
                            shapes.push(shape);
                        });

                        // ... расчет UV ...
                        const UVGenerator = { /* ... */ };

                        let geometry;
                        if (revolution) {
                            // Тело вращения (LatheGeometry)
                            const profile = loops[0].map((p) => new THREE.Vector2(Math.abs(p[0]), p[1]));
                            if (!profile[0].equals(profile[profile.length - 1])) profile.push(profile[0].clone());
                            geometry = new THREE.LatheGeometry(profile, 64);
                            geometry.rotateX(Math.PI / 2);
                        } else if (trajectory) {
                            // Погонаж (SweepGeometry)
                            geometry = sweepGeometry(loops, trajectory);
                        } else {
                            // Обычная панель (ExtrudeGeometry)
                            geometry = new THREE.ExtrudeGeometry(shapes, {
                                depth: thickness, bevelEnabled: false, steps: 1, curveSegments: 16, UVGenerator
                            });
                        }
                        
                        if (!trajectory && !revolution) geometry.translate(0, 0, low);

                        // Применяем запилы и пазы
                        let bevels = 0;
                        if (cuts && !trajectory && !revolution) {
                            const result = cuts.apply(geometry, fields, loops, get, contour, THREE);
                            geometry = result.geometry;
                            bevels = result.count;
                            stats.bevels += bevels;
                            for (const warning of result.warnings) warnings.push(name + ': ' + warning);
                        }

                        geometry.computeBoundingBox();
                        const localSize = geometry.boundingBox.getSize(new THREE.Vector3());
                        geometry.applyMatrix4(matrix);
                        geometry.computeVertexNormals();

                        // Стандартный материал панели
                        const material = new THREE.MeshStandardMaterial({
                            color: 0xdce0df, roughness: 0.8, metalness: 0, side: THREE.DoubleSide,
                            shadowSide: THREE.BackSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
                        });

                        const mesh = new THREE.Mesh(geometry, material);
                        // ... заполнение userData (matrix, thickness, layers, etc.) ...

                        // Отрисовка контуров панели
                        const edges = bevels && cuts ? cuts.outlines(geometry, THREE) : new THREE.EdgesGeometry(geometry, 25);
                        const outline = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
                            color: 0x39434a, transparent: true, opacity: 0.85, depthTest: true, depthWrite: false
                        }));
                        outline.renderOrder = 1;
                        mesh.add(outline);
                        
                        group.add(mesh);
                        (revolution ? revolvedMeshes : panels).push(mesh);
                        stats.panels++;
                    } catch (error) {
                        stats.unsupported++;
                        warnings.push(name + ': ' + error.message);
                    }
                } 
                // ==========================================
                // 2.2 ОБРАБОТКА ФУРНИТУРЫ (type 3001)
                // ==========================================
                else if (type === 3001) {
                    const f = fittings.get(get(fields, 'FastID'));
                    if (f) {
                        const triData = get(f, 'TriData');
                        let solid = false; // Есть ли у нас готовая 3D-модель фурнитуры

                        // Блок 1: Пытаемся построить фурнитуру из готового меша (TriData)
                        if (hardwareCodec && triData) {
                            try {
                                const id = get(fields, 'FastID');
                                if (!hardwareTemplates.has(id)) {
                                    const decoded = hardwareCodec.decode(triData);
                                    hardwareTemplates.set(id, {
                                        geometry: hardwareCodec.geometry(decoded, THREE),
                                        materials: decoded.groups.map((group) => group.materialName),
                                        triangles: decoded.triangles
                                    });
                                }
                                const template = hardwareTemplates.get(id);
                                if (template.triangles) {
                                    const geometry = template.geometry.clone();
                                    geometry.applyMatrix4(matrix);
                                    
                                    // ВАШЕ ИСПРАВЛЕНИЕ: Более металлический материал
                                    const materialName = template.materials.filter(Boolean).join(' / ') || get(f, 'Name', name);
                                    const dark = /черн|black/i.test(materialName);
                                    const material = new THREE.MeshStandardMaterial({
                                        color: dark ? 0x1a1a1a : 0xe0e0e0, // Темный или светлый металл
                                        roughness: dark ? 0.4 : 0.15,      // Гладкий
                                        metalness: dark ? 0.5 : 0.9,       // Сильный металл
                                        side: THREE.DoubleSide, shadowSide: THREE.BackSide,
                                        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
                                    });

                                    const mesh = new THREE.Mesh(geometry, material);
                                    mesh.name = name;
                                    // ... userData ...

                                    const outline = new THREE.LineSegments(
                                        new THREE.EdgesGeometry(geometry, 65),
                                        new THREE.LineBasicMaterial({ color: 0x39434a, transparent: true, opacity: 0.7, depthTest: true })
                                    );
                                    mesh.add(outline);
                                    mesh.userData.treeNodeId = treeNode.id;
                                    
                                    group.add(mesh);
                                    hardwareMeshes.push(mesh);
                                    solid = true;
                                }
                            } catch (error) {
                                warnings.push(name + ': ' + error.message);
                            }
                        }

                        const min = vector(f, ['MinX', 'MinY', 'MinZ']),
                            max = vector(f, ['MaxX', 'MaxY', 'MaxZ']);
                        const size = max.clone().sub(min);

                        // Если есть 3D-меш, добавляем зеленый контур вокруг него
                        if (solid) {
                            const mesh = hardwareMeshes[hardwareMeshes.length - 1];
                            const outline = new THREE.LineSegments(
                                new THREE.EdgesGeometry(mesh.geometry, 30),
                                new THREE.LineBasicMaterial({ color: 0x197c45, depthTest: true, depthWrite: false })
                            );
                            hardware.add(outline);
                        }

                        // Блок 2: Обработка отверстий фурнитуры (сверловки)
                        const holes = get(f, 'Holes', []).filter((entry) => entry.name === 'Hole' && Array.isArray(entry.value));
                        
                        // Сохраняем данные для чертежей
                        for (const hole of holes) {
                            const radius = get(hole.value, 'Radius', 0),
                                depth = get(hole.value, 'Depth', 0);
                            const direction = vector(hole.value, ['DirX', 'DirY', 'DirZ']);
                            if (radius > 0 && depth > 0 && direction.lengthSq() > 0.5)
                                drillings.push({
                                    start: vector(hole.value, ['X', 'Y', 'Z']).applyMatrix4(matrix),
                                    direction: direction.transformDirection(matrix),
                                    radius, depth, name: String(name)
                                });
                        }

                        if (holes.length) {
                            // ==========================================
                            // ВАШЕ ДОБАВЛЕНИЕ: 3D-ЦИЛИНДРЫ ДЛЯ ОТВЕРСТИЙ
                            // ==========================================
                            if (!solid) {
                                for (const hole of holes) {
                                    const fields = hole.value;
                                    const radius = get(fields, 'Radius', 0),
                                        depth = get(fields, 'Depth', 0);
                                    const axis = vector(fields, ['DirX', 'DirY', 'DirZ']);
                                    
                                    if (!(radius > 0 && depth > 0) || axis.lengthSq() < 0.5) continue;
                                    
                                    axis.normalize();
                                    const start = vector(fields, ['X', 'Y', 'Z']);
                                    
                                    // Создаем цилиндр
                                    const cylGeo = new THREE.CylinderGeometry(radius, radius, depth, 16);
                                    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
                                    const centerPos = start.clone().addScaledVector(axis, depth / 2);
                                    
                                    const matrixHole = new THREE.Matrix4().compose(centerPos, quat, new THREE.Vector3(1, 1, 1)).premultiply(matrix);
                                    cylGeo.applyMatrix4(matrixHole);
                                    
                                    // Материал для сверловки
                                    const holeMat = new THREE.MeshStandardMaterial({
                                        color: 0xcccccc, metalness: 0.5, roughness: 0.4, side: THREE.DoubleSide
                                    });
                                    
                                    const holeMesh = new THREE.Mesh(cylGeo, holeMat);
                                    holeMesh.name = name;
                                    holeMesh.userData = {
                                        isHardware: true, localMatrix: matrix.clone(), materialName: 'Крепеж',
                                        thickness: depth, baseThickness: depth, layers: [], isLayered: false,
                                        fields: fields, baseUV: new Float32Array(0), sideUVRanges: [],
                                        textureAngle: 0, textureDirection: 0, artPos: '',
                                        dimensions: [radius * 2, depth, radius * 2].sort((a, b) => b - a),
                                        treeNodeId: treeNode.id 
                                    };

                                    group.add(holeMesh);
                                    hardware.add(holeMesh); 
                                    hardwareMeshes.push(holeMesh);
                                }
                            }
                            
                            // Блок 3: Отрисовка зеленых контуров отверстий
                            const lines = [];
                            for (const hole of holes) {
                                const fields = hole.value,
                                    radius = get(fields, 'Radius', 0),
                                    depth = get(fields, 'Depth', 0);
                                const axis = vector(fields, ['DirX', 'DirY', 'DirZ']);
                                if (!(radius > 0 && depth > 0) || axis.lengthSq() < 0.5) continue;
                                axis.normalize();
                                
                                const start = vector(fields, ['X', 'Y', 'Z']),
                                    end = start.clone().addScaledVector(axis, depth);
                                    
                                // Строим 2 перпендикулярных вектора для кругов
                                const u = new THREE.Vector3(Math.abs(axis.x) < 0.9 ? 1 : 0, Math.abs(axis.x) < 0.9 ? 0 : 1, 0).cross(axis).normalize();
                                const v = axis.clone().cross(u);
                                
                                const point = (center, angle) =>
                                    center.clone()
                                        .addScaledVector(u, radius * Math.cos(angle))
                                        .addScaledVector(v, radius * Math.sin(angle));
                                        
                                const line = (a, b) => {
                                    for (const p of [a, b]) { p.applyMatrix4(matrix); lines.push(p.x, p.y, p.z); }
                                };
                                
                                // Два круга (верх и низ)
                                for (let i = 0; i < 24; i++)
                                    for (const center of [start, end])
                                        line(point(center, (i * Math.PI) / 12), point(center, ((i + 1) * Math.PI) / 12));
                                        
                                // 4 вертикальные линии
                                for (let i = 0; i < 4; i++)
                                    line(point(start, (i * Math.PI) / 2), point(end, (i * Math.PI) / 2));
                            }
                            
                            if (lines.length) {
                                const geometry = new THREE.BufferGeometry();
                                geometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
                                const outline = new THREE.LineSegments(
                                    geometry,
                                    new THREE.LineBasicMaterial({
                                        color: 0x197c45, depthTest: true, depthWrite: false // depthTest: true!
                                    })
                                );
                                outline.name = name;
                                outline.userData.isFastenerContour = true;
                                outline.renderOrder = 3;
                                hardware.add(outline);
                            }
                        }
                    } else stats.unsupported++;
                } 
                // Служебные объекты и нераспознанные типы
                else if ([1001, 1002, 1005, 4001, 4004, 9000].includes(type)) stats.service++;
                else if (type !== undefined) {
                    stats.unsupported++;
                    warnings.push(name + ': тип ' + type);
                }
                
                // Рекурсивный вызов для дочерних узлов
                visit(fields, matrix, continued, treeNode.children);
            }
        }

        // Запускаем обход сцены
        const scene = parsed.scene || (parsed.document ? parsed.model.concat(parsed.document.filter((node) => node.name === 'Obj')) : parsed.model);
        visit(scene, new THREE.Matrix4());

        // ==========================================
        // 3. ФИНАЛЬНАЯ СБОРКА И СОРТИРОВКА
        // ==========================================
        
        // Сортируем панели для правильного наложения прозрачных/добавленных элементов
        panels.sort((a, b) =>
            Number(a.userData.continuation) * 2 + Number(a.userData.addedGeometry) -
            (Number(b.userData.continuation) * 2 + Number(b.userData.addedGeometry))
        );

        // Добавляем фурнитуру и тела вращения в общий массив панелей
        panels.push(...hardwareMeshes);
        panels.push(...revolvedMeshes);
        
        // Привязываем индексы панелей к узлам дерева
        panels.forEach((panel, index) => treeNodes.get(panel.userData.treeNodeId).ownIndices.push(index));
        
        // Собираем дерево (вычисляем indices рекурсивно)
        function collectTree(nodes) {
            for (let i = nodes.length - 1; i >= 0; i--) {
                const node = nodes[i];
                collectTree(node.children);
                node.indices = node.ownIndices.concat(node.children.flatMap((child) => child.indices));
                if (!node.indices.length) nodes.splice(i, 1); // Удаляем пустые ветки
            }
        }
        collectTree(tree);

        // Очищаем кэш временных шаблонов
        for (const template of hardwareTemplates.values()) template.geometry.dispose();
        group.updateMatrixWorld(true);

        // Возвращаем готовую сцену
        return {
            group,            // Корневая группа для добавления в сцену Three.js
            hardware,         // Группа зеленых контуров фурнитуры
            panels,           // Массив всех мешей
            stats,            // Статистика
            warnings,         // Предупреждения
            tree,             // Дерево для UI
            drillings,        // Отверстия для чертежей
            bounds: new THREE.Box3().setFromObject(group) // Габариты всей модели
        };
    }

    const api = { build };
    root.BazisScene = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
