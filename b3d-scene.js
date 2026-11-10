(function (root) {
    'use strict';
    function build(parsed, THREE) {
        const { get, contour } = root.BazisB3D || require('./b3d-parser.js');
        const cuts = root.BazisCuts || (typeof require === 'function' ? require('./b3d-cuts.js') : null);
        const hardwareCodec =
            root.BazisHardware || (typeof require === 'function' ? require('./b3d-hardware.js') : null);
        const hardwareTemplates = new Map(),
            hardwareMeshes = [],
            revolvedMeshes = [];
        const group = new THREE.Group(),
            hardware = new THREE.Group(),
            panels = [],
            warnings = [];
        const tree = [],
            treeNodes = new Map(),
            drillings = [];
        let treeSequence = 0;
        const stats = {
            panels: 0,
            hardware: 0,
            hardwareMeshes: 0,
            hardwareTriangles: 0,
            service: 0,
            unsupported: 0,
            layered: 0,
            bevels: 0
        };
        const fittings = new Map(
            get(parsed.document || [], 'FurnList', []).map((n) => [get(n.value, 'FastID'), n.value])
        );
        const vector = (fields, keys) => new THREE.Vector3(...keys.map((key) => get(fields, key, 0)));
        function sweepGeometry(profileLoops, trajectory) {
            const positions = [],
                uvs = [],
                caps = [],
                sides = [];
            for (const path of contour(trajectory, true)) {
                const closed =
                    Math.hypot(path[0][0] - path[path.length - 1][0], path[0][1] - path[path.length - 1][1]) < 0.01;
                const distances = [0];
                for (let i = 1; i < path.length; i++)
                    distances[i] =
                        distances[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
                for (const sourceLoop of profileLoops) {
                    const loop = THREE.ShapeUtils.isClockWise(sourceLoop.map((p) => new THREE.Vector2(...p)))
                        ? sourceLoop
                        : sourceLoop.slice().reverse();
                    const rings = path.map((point, index) => {
                        const before =
                                closed && (index === 0 || index === path.length - 1)
                                    ? path[path.length - 2]
                                    : path[Math.max(0, index - 1)],
                            after =
                                closed && (index === 0 || index === path.length - 1)
                                    ? path[1]
                                    : path[Math.min(path.length - 1, index + 1)];
                        const a = new THREE.Vector2(point[0] - before[0], point[1] - before[1]).normalize();
                        const b = new THREE.Vector2(after[0] - point[0], after[1] - point[1]).normalize();
                        if (!closed && index === 0) a.copy(b);
                        if (!closed && index === path.length - 1) b.copy(a);
                        const first = new THREE.Vector2(-a.y, a.x),
                            second = new THREE.Vector2(-b.y, b.x);
                        const normal = first.clone().add(second).normalize();
                        const miter = 1 / Math.max(0.1, normal.dot(first));
                        return loop.map(
                            (p) =>
                                new THREE.Vector3(
                                    point[0] + normal.x * p[0] * miter,
                                    point[1] + normal.y * p[0] * miter,
                                    p[1]
                                )
                        );
                    });
                    const triangles = THREE.ShapeUtils.triangulateShape(
                        loop.map((p) => new THREE.Vector2(...p)),
                        []
                    );
                    for (const triangle of closed ? [] : triangles) {
                        caps.push(
                            triangle
                                .slice()
                                .reverse()
                                .map((i) => ({ p: rings[0][i], uv: loop[i] }))
                        );
                        caps.push(triangle.map((i) => ({ p: rings[rings.length - 1][i], uv: loop[i] })));
                    }
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
        function visit(nodes, parent, continuation = false, treeChildren = tree) {
            for (const node of nodes) {
                if (!Array.isArray(node.value)) continue;
                if (node.name !== 'Obj') {
                    visit(node.value, parent, continuation, treeChildren);
                    continue;
                }
                const continued = continuation || node.continuation === true;
                const legacyTail =
                    Number.isFinite(parsed.legacySceneBoundary) && node.sourceOffset >= parsed.legacySceneBoundary;
                const fields = node.value,
                    trans = get(fields, 'Trans', []),
                    type = get(fields, 'Type');
                const pos = vector(trans, ['X', 'Y', 'Z']);
                const quat = new THREE.Quaternion(
                    get(trans, 'Rx', 0),
                    get(trans, 'Ry', 0),
                    get(trans, 'Rz', 0),
                    get(trans, 'Rw', 1)
                ).normalize();
                const matrix = new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(1, 1, 1)).premultiply(parent);
                const name = get(fields, 'Name', 'Деталь');
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
                if (data && (baseThickness > 0 || trajectory || revolution)) {
                    try {
                        const loops = contour(data);
                        if (!loops.length) throw new Error('Пустой контур');
                        if (trajectory) {
                            const points = loops.flat(),
                                xs = points.map((p) => p[0]),
                                ys = points.map((p) => p[1]);
                            baseThickness = Math.min(
                                Math.max(...xs) - Math.min(...xs),
                                Math.max(...ys) - Math.min(...ys)
                            );
                        }
                        if (revolution) {
                            const points = loops.flat(),
                                xs = points.map((p) => p[0]),
                                ys = points.map((p) => p[1]);
                            baseThickness = Math.min(
                                2 * Math.max(...xs.map(Math.abs)),
                                Math.max(...ys) - Math.min(...ys)
                            );
                        }
                        let low = signedThickness < 0 ? -baseThickness : 0,
                            high = signedThickness < 0 ? 0 : baseThickness;
                        const layers = [
                            {
                                name: 'Основа',
                                materialName: get(fields, 'Mat', ''),
                                thickness: baseThickness,
                                side: 'core',
                                min: low,
                                max: high
                            }
                        ];
                        for (const entry of get(fields, 'Plastics', [])) {
                            if (entry.name !== 'Plastic' || !Array.isArray(entry.value)) continue;
                            const layerThickness = get(entry.value, 'Thick', get(entry.value, 'Thickness'));
                            if (!Number.isFinite(layerThickness) || layerThickness <= 0) continue;
                            const near = get(entry.value, 'Side', 0) === 1;
                            const min = near ? low - layerThickness : high,
                                max = near ? low : high + layerThickness;
                            if (near) low = min;
                            else high = max;
                            layers.push({
                                name: 'Слой',
                                materialName: get(entry.value, 'Mat', ''),
                                thickness: layerThickness,
                                side: near ? 'back' : 'front',
                                min,
                                max
                            });
                        }
                        layers.sort((a, b) => a.min - b.min);
                        const thickness = high - low;

                        const inside = (point, loop) => {
                            let result = false;
                            for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
                                const a = loop[i],
                                    b = loop[j];
                                if (
                                    a[1] > point[1] !== b[1] > point[1] &&
                                    point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
                                )
                                    result = !result;
                            }
                            return result;
                        };
                        const depth = loops.map(
                            (loop, i) => loops.filter((other, j) => j !== i && inside(loop[0], other)).length
                        );
                        const shapes = [];
                        loops.forEach((loop, i) => {
                            if (depth[i] % 2) return;
                            
                            // 1. Создаем точки для основного контура
                            const shapePoints = loop.map((p) => new THREE.Vector2(...p));
                            // Принудительно делаем внешний контур против часовой стрелки (CCW)
                            if (THREE.ShapeUtils.isClockWise(shapePoints)) {
                                shapePoints.reverse();
                            }
                            
                            const shape = new THREE.Shape(shapePoints);
                            
                            loops.forEach((hole, j) => {
                                if (depth[j] === depth[i] + 1 && inside(hole[0], loop)) {
                                    // 2. Создаем точки для отверстий
                                    const holePoints = hole.map((p) => new THREE.Vector2(...p));
                                    // Принудительно делаем отверстия по часовой стрелке (CW)
                                    if (!THREE.ShapeUtils.isClockWise(holePoints)) {
                                        holePoints.reverse();
                                    }
                                    
                                    shape.holes.push(new THREE.Path(holePoints));
                                }
                            });
                            shapes.push(shape);
                        });
                        let minX = Infinity,
                            minY = Infinity;
                        for (const loop of loops)
                            for (const point of loop) {
                                minX = Math.min(minX, point[0]);
                                minY = Math.min(minY, point[1]);
                            }

                        const UVGenerator = {
                            generateTopUV(geometry, vertices, a, b, c) {
                                return [a, b, c].map(
                                    (index) =>
                                        new THREE.Vector2(vertices[index * 3] - minX, vertices[index * 3 + 1] - minY)
                                );
                            },
                            generateSideWallUV(geometry, vertices, a, b, c, d) {
                                const dx = vertices[b * 3] - vertices[a * 3],
                                    dy = vertices[b * 3 + 1] - vertices[a * 3 + 1],
                                    length = Math.hypot(dx, dy) || 1;
                                return [a, b, c, d].map(
                                    (index) =>
                                        new THREE.Vector2(
                                            ((vertices[index * 3] - minX) * dx +
                                                (vertices[index * 3 + 1] - minY) * dy) /
                                                length,
                                            vertices[index * 3 + 2]
                                        )
                                );
                            }
                        };
                        let geometry;
                        if (revolution) {
                            if (loops.length !== 1) throw new Error('Тело вращения: ожидается один профиль');
                            const profile = loops[0].map((p) => new THREE.Vector2(Math.abs(p[0]), p[1]));
                            if (!profile[0].equals(profile[profile.length - 1])) profile.push(profile[0].clone());
                            geometry = new THREE.LatheGeometry(profile, 64);

                            geometry.rotateX(Math.PI / 2);
                        } else
                            geometry = trajectory
                                ? sweepGeometry(loops, trajectory)
                                : new THREE.ExtrudeGeometry(shapes, {
                                      depth: thickness,
                                      bevelEnabled: false,
                                      steps: 1,
                                      curveSegments: 16,
                                      UVGenerator
                                  });
                        if (!trajectory && !revolution) geometry.translate(0, 0, low);
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

                        const material = new THREE.MeshStandardMaterial({
                            color: 0xdce0df,
                            roughness: 0.8,
                            metalness: 0,
                            side: THREE.DoubleSide,
                            shadowSide: THREE.BackSide,
                            polygonOffset: true,
                            polygonOffsetFactor: 1,
                            polygonOffsetUnits: 1
                        });
                        const mesh = new THREE.Mesh(geometry, material);
                        const artPos = get(fields, 'ArtPos', '');
                        const texDir = get(fields, 'TexDir', 0),
                            texAngle = get(fields, 'TexAngle');
                        mesh.name = name;
                        mesh.userData = {
                            bevels,
                            continuation: legacyTail || continued,
                            addedGeometry: signedThickness < 0 || Boolean(trajectory),
                            localMatrix: matrix.clone(),
                            materialName: get(fields, 'Mat', ''),
                            thickness,
                            baseThickness,
                            layers,
                            isLayered: layers.length > 1,
                            fields,
                            baseUV: geometry.attributes.uv.array.slice(),
                            sideUVRanges: geometry.groups
                                .filter((group) => group.materialIndex === 1)
                                .map((group) => ({ start: group.start, count: group.count })),
                            textureAngle:
                                typeof texAngle === 'number' && Number.isFinite(texAngle)
                                    ? texAngle
                                    : texDir === 1
                                      ? Math.PI / 2
                                      : 0,
                            textureDirection: texDir,
                            artPos:
                                typeof artPos === 'string' || typeof artPos === 'number' ? String(artPos).trim() : '',
                            dimensions:
                                trajectory || revolution
                                    ? localSize.toArray().sort((a, b) => b - a)
                                    : [
                                          Math.max(localSize.x, localSize.y),
                                          Math.min(localSize.x, localSize.y),
                                          bevels ? localSize.z : thickness
                                      ]
                        };
                        const edges =
                            bevels && cuts ? cuts.outlines(geometry, THREE) : new THREE.EdgesGeometry(geometry, 25);
                        if (layers.length > 1) stats.layered++;
                        if (layers.length > 1 && !bevels) {
                            const lines = Array.from(edges.attributes.position.array);
                            for (const layer of layers.slice(0, -1))
                                for (const loop of loops)
                                    for (let i = 0; i < loop.length; i++) {
                                        for (const point of [loop[i], loop[(i + 1) % loop.length]]) {
                                            const p = new THREE.Vector3(point[0], point[1], layer.max).applyMatrix4(
                                                matrix
                                            );
                                            lines.push(p.x, p.y, p.z);
                                        }
                                    }
                            edges.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
                        }
                        const outline = new THREE.LineSegments(
                            edges,
                            new THREE.LineBasicMaterial({
                                color: 0x39434a,
                                transparent: true,
                                opacity: 0.85,
                                depthTest: true,
                                depthWrite: false
                            })
                        );
                        outline.renderOrder = 1;
                        mesh.add(outline);
                        mesh.userData.treeNodeId = treeNode.id;
                        group.add(mesh);
                        (revolution ? revolvedMeshes : panels).push(mesh);
                        stats.panels++;
                    } catch (error) {
                        stats.unsupported++;
                        warnings.push(name + ': ' + error.message);
                    }
                } else if (type === 3001) {
                    const f = fittings.get(get(fields, 'FastID'));
                    if (f) {
                        const triData = get(f, 'TriData');
                        let solid = false;
                        if (hardwareCodec && triData)
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
                                    const geometry = template.geometry.clone(),
                                        size = geometry.boundingBox.getSize(new THREE.Vector3());
                                    geometry.applyMatrix4(matrix);
                                    geometry.computeBoundingBox();
                                    geometry.computeBoundingSphere();
                                    const materialName =
                                        template.materials.filter(Boolean).join(' / ') || get(f, 'Name', name);
                                    const dark = /черн|black/i.test(materialName);
                                    const material = new THREE.MeshStandardMaterial({
                                        color: dark ? 0x1a1a1a : 0xe0e0e0, // Более светлый серебристый
                                        roughness: dark ? 0.4 : 0.15,      // Гладкая поверхность
                                        metalness: dark ? 0.5 : 0.9,       // Сильный металл
                                        side: THREE.DoubleSide,
                                        shadowSide: THREE.BackSide,
                                        polygonOffset: true,
                                        polygonOffsetFactor: 1,
                                        polygonOffsetUnits: 1
                                    });
                                    const mesh = new THREE.Mesh(geometry, material),
                                        thickness = Math.min(size.x, size.y, size.z),
                                        artPos = get(fields, 'ArtPos', '');
                                    mesh.name = name;
                                    mesh.userData = {
                                        isHardware: true,
                                        localMatrix: matrix.clone(),
                                        materialName,
                                        thickness,
                                        baseThickness: thickness,
                                        layers: [],
                                        isLayered: false,
                                        fields,
                                        baseUV: geometry.attributes.uv.array.slice(),
                                        sideUVRanges: [],
                                        textureAngle: 0,
                                        textureDirection: 0,
                                        artPos: String(artPos).trim(),
                                        dimensions: size.toArray().sort((a, b) => b - a)
                                    };
                                    const outline = new THREE.LineSegments(
                                        new THREE.EdgesGeometry(geometry, 65),
                                        new THREE.LineBasicMaterial({
                                            color: 0x39434a,
                                            transparent: true,
                                            opacity: 0.7,
                                            depthTest: true,
                                            depthWrite: false
                                        })
                                    );
                                    outline.renderOrder = 1;
                                    mesh.add(outline);
                                    mesh.userData.treeNodeId = treeNode.id;
                                    group.add(mesh);
                                    hardwareMeshes.push(mesh);
                                    stats.hardwareMeshes++;
                                    stats.hardwareTriangles += template.triangles;
                                    solid = true;
                                }
                            } catch (error) {
                                warnings.push(name + ': ' + error.message);
                            }
                        const min = vector(f, ['MinX', 'MinY', 'MinZ']),
                            max = vector(f, ['MaxX', 'MaxY', 'MaxZ']);
                        const size = max.clone().sub(min);
                        if (solid) {
                            const mesh = hardwareMeshes[hardwareMeshes.length - 1];
                            let contourGeometry = null;
                            if (get(f, 'Edges') && hardwareCodec.edges) {
                                try {
                                    contourGeometry = hardwareCodec.edges(get(f, 'Edges'), THREE);
                                    contourGeometry.applyMatrix4(matrix);
                                } catch (_) {}
                            }
                            if (!contourGeometry) contourGeometry = new THREE.EdgesGeometry(mesh.geometry, 30);
                            const outline = new THREE.LineSegments(
                                contourGeometry,
                                new THREE.LineBasicMaterial({ color: 0x197c45, depthTest: true, depthWrite: false })
                            );
                            outline.name = name;
                            outline.userData.isFastenerContour = true;
                            outline.renderOrder = 3;
                            hardware.add(outline);
                            stats.hardware++;
                        }
                        const holes = get(f, 'Holes', []).filter(
                            (entry) => entry.name === 'Hole' && Array.isArray(entry.value)
                        );
                        for (const hole of holes) {
                            const radius = get(hole.value, 'Radius', 0),
                                depth = get(hole.value, 'Depth', 0);
                            const direction = vector(hole.value, ['DirX', 'DirY', 'DirZ']);
                            if (radius > 0 && depth > 0 && direction.lengthSq() > 0.5)
                                drillings.push({
                                    start: vector(hole.value, ['X', 'Y', 'Z']).applyMatrix4(matrix),
                                    direction: direction.transformDirection(matrix),
                                    radius,
                                    depth,
                                    name: String(name)
                                });
                        }
                        if (holes.length) {
                            // 1. Создаем объемные цилиндры, если нет готового 3D-меша
                            if (!solid) {
                                for (const hole of holes) {
                                    const fields = hole.value,
                                        radius = get(fields, 'Radius', 0),
                                        depth = get(fields, 'Depth', 0);
                                    const axis = vector(fields, ['DirX', 'DirY', 'DirZ']);
                                    
                                    if (!(radius > 0 && depth > 0) || axis.lengthSq() < 0.5) continue;
                                    
                                    axis.normalize();
                                    const start = vector(fields, ['X', 'Y', 'Z']);
                                    const cylGeo = new THREE.CylinderGeometry(radius, radius, depth, 16);
                                    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
                                    const centerPos = start.clone().addScaledVector(axis, depth / 2);
                                    
                                    const matrixHole = new THREE.Matrix4().compose(centerPos, quat, new THREE.Vector3(1, 1, 1)).premultiply(matrix);
                                    cylGeo.applyMatrix4(matrixHole);
                                    
                                    const holeMat = new THREE.MeshStandardMaterial({
                                        color: 0xcccccc, 
                                        metalness: 0.5,
                                        roughness: 0.4,
                                        side: THREE.DoubleSide
                                    });
                                    
                                    const holeMesh = new THREE.Mesh(cylGeo, holeMat);
                                    
                                    holeMesh.name = name;
                                    holeMesh.userData = {
                                        isHardware: true,
                                        localMatrix: matrix.clone(),
                                        materialName: 'Крепеж',
                                        thickness: depth,
                                        baseThickness: depth,
                                        layers: [],
                                        isLayered: false,
                                        fields: fields,
                                        baseUV: new Float32Array(0),
                                        sideUVRanges: [],
                                        textureAngle: 0,
                                        textureDirection: 0,
                                        artPos: '',
                                        dimensions: [radius * 2, depth, radius * 2].sort((a, b) => b - a),
                                        treeNodeId: treeNode.id 
                                    };

                                    group.add(holeMesh);
                                    hardware.add(holeMesh); 
                                    hardwareMeshes.push(holeMesh);
                                }
                            }
                            
                            // 2. Зеленые контуры (с исправленным depthTest: true)
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
                                const u = new THREE.Vector3(
                                    Math.abs(axis.x) < 0.9 ? 1 : 0,
                                    Math.abs(axis.x) < 0.9 ? 0 : 1,
                                    0
                                )
                                    .cross(axis)
                                    .normalize();
                                const v = axis.clone().cross(u);
                                const point = (center, angle) =>
                                    center
                                        .clone()
                                        .addScaledVector(u, radius * Math.cos(angle))
                                        .addScaledVector(v, radius * Math.sin(angle));
                                const line = (a, b) => {
                                    for (const p of [a, b]) {
                                        p.applyMatrix4(matrix);
                                        lines.push(p.x, p.y, p.z);
                                    }
                                };
                                for (let i = 0; i < 24; i++)
                                    for (const center of [start, end])
                                        line(
                                            point(center, (i * Math.PI) / 12),
                                            point(center, ((i + 1) * Math.PI) / 12)
                                        );
                                for (let i = 0; i < 4; i++)
                                    line(point(start, (i * Math.PI) / 2), point(end, (i * Math.PI) / 2));
                            }
                            if (lines.length) {
                                const geometry = new THREE.BufferGeometry();
                                geometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
                                const outline = new THREE.LineSegments(
                                    geometry,
                                    new THREE.LineBasicMaterial({
                                        color: 0x197c45,
                                        depthTest: true,
                                        depthWrite: false
                                    })
                                );
                                outline.name = name;
                                outline.userData.isFastenerContour = true;
                                outline.renderOrder = 3;
                                hardware.add(outline);
                                if (!solid) stats.hardware++;
                            } else if (!solid) stats.unsupported++;
                        } else if (!solid && size.x > 0 && size.y > 0 && size.z > 0) {
                            const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
                            geometry.translate(...min.clone().add(max).multiplyScalar(0.5).toArray());
                            geometry.applyMatrix4(matrix);
                            hardware.add(
                                new THREE.LineSegments(
                                    new THREE.EdgesGeometry(geometry),
                                    new THREE.LineBasicMaterial({
                                        color: 0x96d56a,
                                        depthTest: true,
                                        transparent: true,
                                        opacity: 0.65
                                    })
                                )
                            );
                            geometry.dispose();
                            stats.hardware++;
                        } else if (!solid) stats.unsupported++;
                    } else stats.unsupported++;
                } else if ([1001, 1002, 1005, 4001, 4004, 9000].includes(type)) stats.service++;
                else if (type !== undefined) {
                    stats.unsupported++;
                    warnings.push(name + ': тип ' + type);
                }
                visit(fields, matrix, continued, treeNode.children);
            }
        }
        const scene =
            parsed.scene ||
            (parsed.document
                ? parsed.model.concat(parsed.document.filter((node) => node.name === 'Obj'))
                : parsed.model);
        visit(scene, new THREE.Matrix4());

        panels.sort(
            (a, b) =>
                Number(a.userData.continuation) * 2 +
                Number(a.userData.addedGeometry) -
                (Number(b.userData.continuation) * 2 + Number(b.userData.addedGeometry))
        );

        panels.push(...hardwareMeshes);
        panels.push(...revolvedMeshes);
        panels.forEach((panel, index) => treeNodes.get(panel.userData.treeNodeId).ownIndices.push(index));
        function collectTree(nodes) {
            for (let i = nodes.length - 1; i >= 0; i--) {
                const node = nodes[i];
                collectTree(node.children);
                node.indices = node.ownIndices.concat(node.children.flatMap((child) => child.indices));
                if (!node.indices.length) nodes.splice(i, 1);
            }
        }
        collectTree(tree);
        for (const template of hardwareTemplates.values()) template.geometry.dispose();
        group.updateMatrixWorld(true);
        return {
            group,
            hardware,
            panels,
            stats,
            warnings,
            tree,
            drillings,
            bounds: new THREE.Box3().setFromObject(group)
        };
    }
    const api = { build };
    root.BazisScene = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
