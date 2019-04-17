define([
        '../Core/arraySlice',
        '../Core/Cartesian3',
        '../Core/Color',
        '../Core/ComponentDatatype',
        '../Core/defaultValue',
        '../Core/defined',
        '../Core/defineProperties',
        '../Core/destroyObject',
        '../Core/Ellipsoid',
        '../Core/FeatureDetection',
        '../Core/IndexDatatype',
        '../Core/Matrix4',
        '../Core/Rectangle',
        '../Core/TaskProcessor',
        '../Renderer/Buffer',
        '../Renderer/BufferUsage',
        '../Renderer/DrawCommand',
        '../Renderer/Pass',
        '../Renderer/RenderState',
        '../Renderer/ShaderProgram',
        '../Renderer/ShaderSource',
        '../Renderer/VertexArray',
        '../Shaders/PolylineCommon',
        '../Shaders/Vector3DTileClampedPolylinesVS',
        '../Shaders/Vector3DTileClampedPolylinesFS',
        '../ThirdParty/when',
        './BlendingState',
        './Cesium3DTileFeature',
        './CullFace'
    ], function(
        arraySlice,
        Cartesian3,
        Color,
        ComponentDatatype,
        defaultValue,
        defined,
        defineProperties,
        destroyObject,
        Ellipsoid,
        FeatureDetection,
        IndexDatatype,
        Matrix4,
        Rectangle,
        TaskProcessor,
        Buffer,
        BufferUsage,
        DrawCommand,
        Pass,
        RenderState,
        ShaderProgram,
        ShaderSource,
        VertexArray,
        PolylineCommon,
        Vector3DTileClampedPolylinesVS,
        Vector3DTileClampedPolylinesFS,
        when,
        BlendingState,
        Cesium3DTileFeature,
        CullFace) {
    'use strict';

    /**
     * Creates a batch of polylines as volumes with shader-adjustable width.
     *
     * @alias Vector3DTileClampedPolylines
     * @constructor
     *
     * @param {Object} options An object with following properties:
     * @param {Uint16Array} options.positions The positions of the polylines
     * @param {Uint32Array} options.counts The number or positions in the each polyline.
     * @param {Uint16Array} options.widths The width of each polyline.
     * @param {Number} options.minimumHeight The minimum height of the tile's region.
     * @param {Number} options.maximumHeight The maximum height of the tile's region.
     * @param {Rectangle} options.rectangle The rectangle containing the tile.
     * @param {Cartesian3} [options.center=Cartesian3.ZERO] The RTC center.
     * @param {Cesium3DTileBatchTable} options.batchTable The batch table for the tile containing the batched polylines.
     * @param {Uint16Array} options.batchIds The batch ids for each polyline.
     * @param {BoundingSphere} options.boundingVolume The bounding volume for the entire batch of polylines.
     * @param {Cesium3DTileset} options.tileset Tileset carrying minimum and maximum clamping heights.
     *
     * @private
     */
    function Vector3DTileClampedPolylines(options) {
        // these arrays hold data from the tile payload
        // and are all released after the first update.
        this._positions = options.positions;
        this._widths = options.widths;
        this._counts = options.counts;
        this._batchIds = options.batchIds;

        this._ellipsoid = defaultValue(options.ellipsoid, Ellipsoid.WGS84);
        this._minimumHeight = options.minimumHeight;
        this._maximumHeight = options.maximumHeight;
        this._center = options.center;
        this._rectangle = options.rectangle;

        this._boundingVolume = options.boundingVolume;
        this._batchTable = options.batchTable;

        this._va = undefined;
        this._sp = undefined;
        this._rs = undefined;
        this._uniformMap = undefined;
        this._command = undefined;

        this._transferrableBatchIds = undefined;
        this._packedBuffer = undefined;
        this._tileset = options.tileset;

        // Fat vertices - all information for each volume packed to a vec3 and 5 vec4s
        this._startEllipsoidNormals = undefined;
        this._endEllipsoidNormals = undefined;
        this._startPositionAndHeights = undefined;
        this._startFaceNormalAndVertexCorners = undefined;
        this._endPositionAndHeights = undefined;
        this._endFaceNormalAndHalfWidths = undefined;
        this._vertexBatchIds = undefined;

        this._indices = undefined;

        this._constantColor = Color.clone(Color.WHITE);
        this._highlightColor = this._constantColor;

        this._trianglesLength = 0;
        this._geometryByteLength = 0;

        this._ready = false;
        this._readyPromise = when.defer();

        this._verticesPromise = undefined;
    }

    defineProperties(Vector3DTileClampedPolylines.prototype, {
        /**
         * Gets the number of triangles.
         *
         * @memberof Vector3DTileClampedPolylines.prototype
         *
         * @type {Number}
         * @readonly
         */
        trianglesLength : {
            get : function() {
                return this._trianglesLength;
            }
        },

        /**
         * Gets the geometry memory in bytes.
         *
         * @memberof Vector3DTileClampedPolylines.prototype
         *
         * @type {Number}
         * @readonly
         */
        geometryByteLength : {
            get : function() {
                return this._geometryByteLength;
            }
        },

        /**
         * Gets a promise that resolves when the primitive is ready to render.
         * @memberof Vector3DTileClampedPolylines.prototype
         * @type {Promise}
         * @readonly
         */
        readyPromise : {
            get : function() {
                return this._readyPromise.promise;
            }
        }
    });

    function packBuffer(polylines) {
        var rectangle = polylines._rectangle;
        var minimumHeight = polylines._minimumHeight;
        var maximumHeight = polylines._maximumHeight;
        var ellipsoid = polylines._ellipsoid;
        var center = polylines._center;

        var packedLength = 2 + Rectangle.packedLength + Ellipsoid.packedLength + Cartesian3.packedLength;
        var packedBuffer = new Float64Array(packedLength);

        var offset = 0;
        packedBuffer[offset++] = minimumHeight;
        packedBuffer[offset++] = maximumHeight;

        Rectangle.pack(rectangle, packedBuffer, offset);
        offset += Rectangle.packedLength;

        Ellipsoid.pack(ellipsoid, packedBuffer, offset);
        offset += Ellipsoid.packedLength;

        Cartesian3.pack(center, packedBuffer, offset);

        return packedBuffer;
    }

    var createVerticesTaskProcessor = new TaskProcessor('createVectorTileClampedPolylines');
    var attributeLocations = {
        startEllipsoidNormal : 0,
        endEllipsoidNormal : 1,
        startPositionAndHeight : 2,
        endPositionAndHeight : 3,
        startFaceNormalAndVertexCorner : 4,
        endFaceNormalAndHalfWidth : 5,
        a_batchId : 6
    };

    function createVertexArray(polylines, context) {
        if (defined(polylines._va)) {
            return;
        }

        if (!defined(polylines._verticesPromise)) {
            var positions = polylines._positions;
            var widths = polylines._widths;
            var counts = polylines._counts;
            var batchIds = polylines._transferrableBatchIds;

            var packedBuffer = polylines._packedBuffer;

            if (!defined(packedBuffer)) {
                // Copy because they may be the views on the same buffer.
                positions = polylines._positions = arraySlice(positions);
                widths = polylines._widths = arraySlice(widths);
                counts = polylines._counts = arraySlice(counts);

                batchIds = polylines._transferrableBatchIds = arraySlice(polylines._batchIds);

                packedBuffer = polylines._packedBuffer = packBuffer(polylines);
            }

            var transferrableObjects = [positions.buffer, widths.buffer, counts.buffer, batchIds.buffer, packedBuffer.buffer];
            var parameters = {
                positions : positions.buffer,
                widths : widths.buffer,
                counts : counts.buffer,
                batchIds : batchIds.buffer,
                packedBuffer : packedBuffer.buffer
            };

            var verticesPromise = polylines._verticesPromise = createVerticesTaskProcessor.scheduleTask(parameters, transferrableObjects);
            if (!defined(verticesPromise)) {
                // Postponed
                return;
            }

            when(verticesPromise, function(result) {
                polylines._startEllipsoidNormals = new Float32Array(result.startEllipsoidNormals);
                polylines._endEllipsoidNormals = new Float32Array(result.endEllipsoidNormals);
                polylines._startPositionAndHeights = new Float32Array(result.startPositionAndHeights);
                polylines._startFaceNormalAndVertexCorners = new Float32Array(result.startFaceNormalAndVertexCorners);
                polylines._endPositionAndHeights = new Float32Array(result.endPositionAndHeights);
                polylines._endFaceNormalAndHalfWidths = new Float32Array(result.endFaceNormalAndHalfWidths);
                polylines._vertexBatchIds = new Uint16Array(result.vertexBatchIds);

                var indexDatatype = result.indexDatatype;
                polylines._indices = indexDatatype === IndexDatatype.UNSIGNED_SHORT ? new Uint16Array(result.indices) : new Uint32Array(result.indices);

                polylines._ready = true;
            });
        }

        if (polylines._ready && !defined(polylines._va)) {
            var startEllipsoidNormals = polylines._startEllipsoidNormals;
            var endEllipsoidNormals = polylines._endEllipsoidNormals;
            var startPositionAndHeights = polylines._startPositionAndHeights;
            var endPositionAndHeights = polylines._endPositionAndHeights;
            var startFaceNormalAndVertexCorners = polylines._startFaceNormalAndVertexCorners;
            var endFaceNormalAndHalfWidths = polylines._endFaceNormalAndHalfWidths;
            var batchIdAttribute = polylines._vertexBatchIds;

            var indices = polylines._indices;

            var byteLength = startEllipsoidNormals.byteLength + endEllipsoidNormals.byteLength;
            byteLength += startPositionAndHeights.byteLength + endPositionAndHeights.byteLength;
            byteLength += startFaceNormalAndVertexCorners.byteLength + endFaceNormalAndHalfWidths.byteLength;
            byteLength += batchIdAttribute.byteLength + indices.byteLength;

            polylines._trianglesLength = indices.length / 3;
            polylines._geometryByteLength = byteLength;

            var startEllipsoidNormalsBuffer = Buffer.createVertexBuffer({
                context : context,
                typedArray : startEllipsoidNormals,
                usage : BufferUsage.STATIC_DRAW
            });
            var endEllipsoidNormalsBuffer = Buffer.createVertexBuffer({
                context : context,
                typedArray : endEllipsoidNormals,
                usage : BufferUsage.STATIC_DRAW
            });
            var startPositionAndHeightsBuffer = Buffer.createVertexBuffer({
                context : context,
                typedArray : startPositionAndHeights,
                usage : BufferUsage.STATIC_DRAW
            });
            var endPositionAndHeightsBuffer = Buffer.createVertexBuffer({
                context : context,
                typedArray : endPositionAndHeights,
                usage : BufferUsage.STATIC_DRAW
            });
            var startFaceNormalAndVertexCornersBuffer = Buffer.createVertexBuffer({
                context : context,
                typedArray : startFaceNormalAndVertexCorners,
                usage : BufferUsage.STATIC_DRAW
            });
            var endFaceNormalAndHalfWidthsBuffer = Buffer.createVertexBuffer({
                context : context,
                typedArray : endFaceNormalAndHalfWidths,
                usage : BufferUsage.STATIC_DRAW
            });
            var batchIdAttributeBuffer = Buffer.createVertexBuffer({
                context : context,
                typedArray : batchIdAttribute,
                usage : BufferUsage.STATIC_DRAW
            });

            var indexBuffer = Buffer.createIndexBuffer({
                context : context,
                typedArray : indices,
                usage : BufferUsage.STATIC_DRAW,
                indexDatatype : (indices.BYTES_PER_ELEMENT === 2) ? IndexDatatype.UNSIGNED_SHORT : IndexDatatype.UNSIGNED_INT
            });

            var vertexAttributes = [{
                index : attributeLocations.startEllipsoidNormal,
                vertexBuffer : startEllipsoidNormalsBuffer,
                componentDatatype : ComponentDatatype.FLOAT,
                componentsPerAttribute : 3
            }, {
                index : attributeLocations.endEllipsoidNormal,
                vertexBuffer : endEllipsoidNormalsBuffer,
                componentDatatype : ComponentDatatype.FLOAT,
                componentsPerAttribute : 3
            }, {
                index : attributeLocations.startPositionAndHeight,
                vertexBuffer : startPositionAndHeightsBuffer,
                componentDatatype : ComponentDatatype.FLOAT,
                componentsPerAttribute : 4
            }, {
                index : attributeLocations.endPositionAndHeight,
                vertexBuffer : endPositionAndHeightsBuffer,
                componentDatatype : ComponentDatatype.FLOAT,
                componentsPerAttribute : 4
            }, {
                index : attributeLocations.startFaceNormalAndVertexCorner,
                vertexBuffer : startFaceNormalAndVertexCornersBuffer,
                componentDatatype : ComponentDatatype.FLOAT,
                componentsPerAttribute : 4
            }, {
                index : attributeLocations.endFaceNormalAndHalfWidth,
                vertexBuffer : endFaceNormalAndHalfWidthsBuffer,
                componentDatatype : ComponentDatatype.FLOAT,
                componentsPerAttribute : 4
            }, {
                index : attributeLocations.a_batchId,
                vertexBuffer : batchIdAttributeBuffer,
                componentDatatype : ComponentDatatype.UNSIGNED_SHORT,
                componentsPerAttribute : 1
            }];

            polylines._va = new VertexArray({
                context : context,
                attributes : vertexAttributes,
                indexBuffer : indexBuffer
            });

            polylines._positions = undefined;
            polylines._widths = undefined;
            polylines._counts = undefined;

            polylines._ellipsoid = undefined;
            polylines._minimumHeight = undefined;
            polylines._maximumHeight = undefined;
            polylines._rectangle = undefined;

            polylines._transferrableBatchIds = undefined;
            polylines._packedBuffer = undefined;

            polylines._startEllipsoidNormals = undefined;
            polylines._endEllipsoidNormals = undefined;
            polylines._startPositionAndHeights = undefined;
            polylines._startFaceNormalAndVertexCorners = undefined;
            polylines._endPositionAndHeights = undefined;
            polylines._endFaceNormalAndHalfWidths = undefined;
            polylines._vertexBatchIds = undefined;

            polylines._indices = undefined;

            polylines._readyPromise.resolve();
        }
    }

    var modifiedModelViewScratch = new Matrix4();
    var rtcScratch = new Cartesian3();

    function createUniformMap(primitive, context) {
        if (defined(primitive._uniformMap)) {
            return;
        }

        primitive._uniformMap = {
            u_modifiedModelView : function() {
                var viewMatrix = context.uniformState.view;
                Matrix4.clone(viewMatrix, modifiedModelViewScratch);
                Matrix4.multiplyByPoint(modifiedModelViewScratch, primitive._center, rtcScratch);
                Matrix4.setTranslation(modifiedModelViewScratch, rtcScratch, modifiedModelViewScratch);
                return modifiedModelViewScratch;
            },
            u_highlightColor : function() {
                return primitive._highlightColor;
            },
            u_minimumMaximumHeight : function() {
                return primitive._tileset.minimumMaximumHeight;
            }
        };
    }

    function createRenderStates(primitive) {
        if (defined(primitive._rs)) {
            return;
        }

        primitive._rs = RenderState.fromCache({
            cull : {
                enabled : true,
                face : CullFace.FRONT // Geometry is "inverted," so cull front when materials on volume instead of on terrain (morph)
            },
            depthTest : {
                enabled : true
            },
            blending : BlendingState.ALPHA_BLEND,
            depthMask : false
        });
    }

    function createShaders(primitive, context) {
        if (defined(primitive._sp)) {
            return;
        }

        var batchTable = primitive._batchTable;

        var vsSource = batchTable.getVertexShaderCallback(false, 'a_batchId', undefined)(Vector3DTileClampedPolylinesVS);
        var fsSource = batchTable.getFragmentShaderCallback()(Vector3DTileClampedPolylinesFS, false, undefined);

        var vs = new ShaderSource({
            defines : ['VECTOR_TILE', !FeatureDetection.isInternetExplorer() ? 'CLIP_POLYLINE' : ''],
            sources : [PolylineCommon, vsSource]
        });
        var fs = new ShaderSource({
            //defines : ['VECTOR_TILE', 'DEBUG_SHOW_VOLUME'],
            defines : ['VECTOR_TILE'],
            sources : [fsSource]
        });

        primitive._sp = ShaderProgram.fromCache({
            context : context,
            vertexShaderSource : vs,
            fragmentShaderSource : fs,
            attributeLocations : attributeLocations
        });
    }

    function queueCommands(primitive, frameState) {
        if (!defined(primitive._command)) {
            var uniformMap = primitive._batchTable.getUniformMapCallback()(primitive._uniformMap);
            primitive._command = new DrawCommand({
                owner : primitive,
                vertexArray : primitive._va,
                renderState : primitive._rs,
                shaderProgram : primitive._sp,
                uniformMap : uniformMap,
                boundingVolume : primitive._boundingVolume,
                pass : Pass.TERRAIN_CLASSIFICATION,
                pickId : primitive._batchTable.getPickId()
            });
        }

        frameState.commandList.push(primitive._command);
    }

    /**
     * Creates features for each polyline and places it at the batch id index of features.
     *
     * @param {Vector3DTileContent} content The vector tile content.
     * @param {Cesium3DTileFeature[]} features An array of features where the polygon features will be placed.
     */
    Vector3DTileClampedPolylines.prototype.createFeatures = function(content, features) {
        var batchIds = this._batchIds;
        var length = batchIds.length;
        for (var i = 0; i < length; ++i) {
            var batchId = batchIds[i];
            features[batchId] = new Cesium3DTileFeature(content, batchId);
        }
    };

    /**
     * Colors the entire tile when enabled is true. The resulting color will be (polyline batch table color * color).
     *
     * @param {Boolean} enabled Whether to enable debug coloring.
     * @param {Color} color The debug color.
     */
    Vector3DTileClampedPolylines.prototype.applyDebugSettings = function(enabled, color) {
        this._highlightColor = enabled ? color : this._constantColor;
    };

    function clearStyle(polygons, features) {
        var batchIds = polygons._batchIds;
        var length = batchIds.length;
        for (var i = 0; i < length; ++i) {
            var batchId = batchIds[i];
            var feature = features[batchId];

            feature.show = true;
            feature.color = Color.WHITE;
        }
    }

    var scratchColor = new Color();

    var DEFAULT_COLOR_VALUE = Color.WHITE;
    var DEFAULT_SHOW_VALUE = true;

    /**
     * Apply a style to the content.
     *
     * @param {Cesium3DTileStyle} style The style.
     * @param {Cesium3DTileFeature[]} features The dictionary of features.
     */
    Vector3DTileClampedPolylines.prototype.applyStyle = function(style, features) {
        if (!defined(style)) {
            clearStyle(this, features);
            return;
        }

        var batchIds = this._batchIds;
        var length = batchIds.length;
        for (var i = 0; i < length; ++i) {
            var batchId = batchIds[i];
            var feature = features[batchId];

            feature.color = defined(style.color) ? style.color.evaluateColor(feature, scratchColor) : DEFAULT_COLOR_VALUE;
            feature.show = defined(style.show) ? style.show.evaluate(feature) : DEFAULT_SHOW_VALUE;
        }
    };

    /**
     * Updates the batches and queues the commands for rendering.
     *
     * @param {FrameState} frameState The current frame state.
     */
    Vector3DTileClampedPolylines.prototype.update = function(frameState) {
        var context = frameState.context;

        createVertexArray(this, context);
        createUniformMap(this, context);
        createShaders(this, context);
        createRenderStates(this);

        if (!this._ready) {
            return;
        }

        var passes = frameState.passes;
        if (passes.render || passes.pick) {
            queueCommands(this, frameState);
        }
    };

    /**
     * Returns true if this object was destroyed; otherwise, false.
     * <p>
     * If this object was destroyed, it should not be used; calling any function other than
     * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
     * </p>
     *
     * @returns {Boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
     */
    Vector3DTileClampedPolylines.prototype.isDestroyed = function() {
        return false;
    };

    /**
     * Destroys the WebGL resources held by this object.  Destroying an object allows for deterministic
     * release of WebGL resources, instead of relying on the garbage collector to destroy this object.
     * <p>
     * Once an object is destroyed, it should not be used; calling any function other than
     * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.  Therefore,
     * assign the return value (<code>undefined</code>) to the object as done in the example.
     * </p>
     *
     * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
     */
    Vector3DTileClampedPolylines.prototype.destroy = function() {
        this._va = this._va && this._va.destroy();
        this._sp = this._sp && this._sp.destroy();
        return destroyObject(this);
    };

    return Vector3DTileClampedPolylines;
});