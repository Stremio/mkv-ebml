var nodeAssert = require('assert');
var nodeAsync = require('async');
var nodeCrc32 = require('crc').crc32;
var nodeStream = require('stream');
var nodeUtil = require('util');
var nodeFs = require('fs');
var utils = require('./utils')

var modelDefinitions = require('./model');

var SPACE_PADDING = "             ";
var SHOULD_PRINT_END = false;
var MASTER_ELEMENT_TYPE = "m";
var EPOCH_TIME = Date.UTC(2001, 0, 1);

function EbmlElement(docRef, idTag, ebmlIdentifier, offsetStart, dataLength) {

	if (!docRef || docRef.type !== 'D') {
		throw new Error("Invalid document");
	}
	this.ownerDocument = docRef;
	this.tagId = idTag;

	var infoSchema = modelDefinitions.byEbmlID[ebmlIdentifier];
	if (infoSchema === undefined || infoSchema === null) {
		infoSchema = {
			"type": "unknown",
			"name": "EBMLID(0x" + ebmlIdentifier.toString(16) + ")"
		};
	}

	this.ebmlID = ebmlIdentifier;
	this.schemaInfo = infoSchema;
	this.type = infoSchema.type;
	this._name = infoSchema.name;

	if (typeof offsetStart === 'number' && !isNaN(offsetStart)) {
		this.start = offsetStart;
		this.length = dataLength || 0;
		this.end = this.start + this.length;
	}
	if (this.type === MASTER_ELEMENT_TYPE) {
		this.masterType = true;
	}
}

module.exports = EbmlElement;

EbmlElement.prototype._setDataSize = function(sizeOfData, sizeOfLengthTag) {
	this.dataSize = sizeOfData;
	this.lengthTagSize = sizeOfLengthTag;
	this.length += sizeOfData + sizeOfLengthTag;
	this.end = this.start + this.length;
};

EbmlElement.prototype._setData = function(payload) {
	this.data = payload;
};

EbmlElement.prototype.getFirstChildByName = function(targetName) {
	var foundChild = undefined;
	this.eachChildByName(targetName, function(childNode) {
		foundChild = childNode;
		return childNode;
	});
	return foundChild;
};

EbmlElement.prototype.listChildrenByName = function(targetName) {
	var matchingChildren = [];
	this.eachChildByName(targetName, function(childNode) {
		matchingChildren.push(childNode);
	});
	return matchingChildren;
};

EbmlElement.prototype.eachChildByName = function(targetName, callbackFunc) {
	var targetEbmlID = utils.convertEbmlID(targetName);
	var processor = callbackFunc || function(c) { return c; };

	if (!this.children) {
		return undefined;
	}

	var nodesToProcess = this.children.slice();
	while (nodesToProcess.length > 0) {
		var currentNode = nodesToProcess.shift();

		if (currentNode.ebmlID === targetEbmlID) {
			var result = processor(currentNode);
			if (result !== undefined) {
				return result;
			}
		} else if (currentNode.children) {
			var childNodes = [0, 0].concat(currentNode.children);
			Array.prototype.splice.apply(nodesToProcess, childNodes);
		}
	}

	return undefined;
};


EbmlElement.prototype.getDirectChildByName = function(targetName) {
	var targetEbmlID = utils.convertEbmlID(targetName);
	var childNodes = this.children;

	if (!childNodes || childNodes.length === 0) {
		return undefined;
	}

	var i = 0;
	var len = childNodes.length;
	while (i < len) {
		var childNode = childNodes[i];
		if (childNode.ebmlID === targetEbmlID) {
			return childNode;
		}
		i += 1;
	}

	return null;
};

EbmlElement.prototype.loadData = function(cb) {
	return cb("Not filled yet");
};

EbmlElement.prototype.getString = function() {
	return this.getBuffer().toString('ascii');
};

EbmlElement.prototype.getUTF8 = function() {
	return this.getBuffer().toString('utf8');
};

EbmlElement.prototype.getValue = function() {
	var elementType = this.type;
	if (elementType === 's') return this.getString();
	if (elementType === '8') return this.getUTF8();
	if (elementType === 'i') return this.getInt();
	if (elementType === 'u') {
		var uintValue = this.getUInt();
		if ((uintValue === 0 || uintValue === 1) && this.schemaInfo && this.schemaInfo.range === "0-1") {
			return uintValue > 0;
		}
		return uintValue;
	}
	if (elementType === 'b') return this.data;
	if (elementType === 'f') return this.getFloat();
	if (elementType === 'd') return this.getDate();

	throw new Error("Type not supported !");
};

EbmlElement.prototype.getBuffer = function() {
	if (!this.data) {
		throw new Error("Data is not loaded ! (tagId=#" + this.tagId + ")");
	}
	return this.data;
};

EbmlElement.prototype.getInt = function() {
	var buf = this.getBuffer();
	var val = buf.readIntBE(0, Math.min(buf.length, 6));
	if (buf.length > 6) {
		var idx = 6;
		while (idx < buf.length) {
			val = val * 256 + buf[idx];
			idx += 1;
		}
	}
	return val;
};

EbmlElement.prototype.getUInt = function() {
	var buf = this.getBuffer();
	var val = buf.readUIntBE(0, Math.min(buf.length, 6));
	if (buf.length > 6) {
		var idx = 6;
		while (idx < buf.length) {
			val = val * 256 + buf[idx];
			idx += 1;
		}
	}
	return val;
};

EbmlElement.prototype.getDataSize = function() {
	if (this.data) {
		return this.data.length;
	}
	return this.dataSize || 0;
};

EbmlElement.prototype.getCRCValue = function() {
	var buf = this.getBuffer();
	if (!buf || buf.length !== 4 || this.type !== 'b') {
		throw new Error("Invalid data");
	}
	return utils.readCRC(buf);
};

EbmlElement.prototype.setFileDataSource = function(filePath, cb) {
	var elementInstance = this;
	nodeFs.stat(filePath, function(err, fileStats) {
		if (err) return cb(err);
		elementInstance.data = undefined;
		elementInstance.type = 'b';
		elementInstance.dataSize = fileStats.size;
		elementInstance._dataSource = {
			getStream: function(streamOptions, streamCallback) {
				var cbFunc = streamCallback;
				var opts = streamOptions;
				if (typeof streamOptions === 'function') {
					cbFunc = streamOptions;
					opts = null;
				}
				var readStream = nodeFs.createReadStream(filePath, opts);
				return cbFunc(null, readStream);
			},
			info: filePath
		};
		elementInstance._markModified();
		return cb(null, elementInstance);
	});
};

EbmlElement.prototype.setCRCValue = function(crcVal) {
	this.data = utils.writeCRC(crcVal);
	this.type = 'b';
	this._markModified();
};

EbmlElement.prototype.getFloat = function() {
	var buf = this.getBuffer();
	var len = buf.length;
	if (len === 4) return buf.readFloatBE(0);
	if (len === 8) return buf.readDoubleBE(0);
	throw new Error("Illegal float size " + len + ".");
};

EbmlElement.prototype.getDateNanos = function() {
	return this.getUInt();
};

EbmlElement.prototype.getDate = function() {
	var buf = this.getBuffer();
	var rawValue = buf.readUIntBE(0, 6);
	var dateObj = new Date(EPOCH_TIME + (rawValue * 256 * 256 / 1000 / 1000));
	return dateObj;
};

EbmlElement.prototype.print = function(indent) {
	var currentLevel = indent || 0;
	var startStr = SPACE_PADDING + (this.start || 0);
	startStr = startStr.substring(startStr.length - 10);

	if (SHOULD_PRINT_END) {
		var endStr = SPACE_PADDING + (this.end || 0);
		endStr = endStr.substring(endStr.length - 10);
		startStr += "-" + endStr;
	}

	var tagIdStr = this.tagId + SPACE_PADDING;
	startStr += "#" + tagIdStr.substring(0, 5) + " ";

	if (currentLevel > 0) {
		var l = 0;
		while (l < currentLevel) {
			startStr += "  ";
			l += 1;
		}
	}

	startStr += "* " + this._name;

	var lenData = (this.data && this.data.length) || this.dataSize || "";

	try {
		if (this.masterType) {
			if (this.type === 'D') {
				startStr += "  " + this.source;
			}
			if (this.start === undefined) {
				// startStr += " children[]";
			} else {
				startStr += "  children[size=" + (this.end - this.start) + "]";
			}
		} else {
			var typeChar = this.type;
			startStr += "  " + typeChar + "[" + lenData + "]";
			if (typeChar === 'u') startStr += "=" + this.getUInt();
			else if (typeChar === 'i') startStr += "=" + this.getInt();
			else if (typeChar === 's') startStr += "='" + this.getString() + "'";
			else if (typeChar === '8') startStr += "='" + (lenData && this.getUTF8()) + "'";
			else if (typeChar === 'f') startStr += "=" + this.getFloat();
			else if (typeChar === 'd') startStr += "=" + this.getDate();
			else if (typeChar === 'b') {
				if (this.data) {
					startStr += "=" + this.data.slice(0, Math.min(32, this.data.length)).toString('hex');
					if (this.ebmlID === modelDefinitions.byName.SeekID) {
						var seekTargetId = this.getUInt();
						var targetInfo = modelDefinitions.byEbmlID[seekTargetId];
						startStr += " => " + (targetInfo ? targetInfo.name : "?");
					}
				} else if (this._dataSource) {
					startStr += "  {dataSource=" + this._dataSource.info + "}";
				}
			}
		}

		if (this._positionTarget) {
			startStr += "  [=>#" + this._positionTarget.tagId + "]";
		}
		if (this._modified) {
			startStr += "  [MODIFIED]";
		}
	} catch (ex) {
		startStr += " error=" + ex;
	}
	startStr += "\n";

	if (this.children) {
		var k = 0;
		var childrenCount = this.children.length;
		while (k < childrenCount) {
			startStr += this.children[k].print(currentLevel + 1);
			k += 1;
		}
	}

	return startStr;
};


EbmlElement.prototype.setString = function(strValue) {
	this.data = new Buffer(strValue, "ascii");
	this.type = 's';
	this._markModified();
};

EbmlElement.prototype.setUTF8 = function(utf8Value) {
	this.data = new Buffer(utf8Value, "utf8");
	this.type = '8';
	this._markModified();
};

EbmlElement.prototype.setInt = function(intValue) {
	this.data = utils.writeInt(intValue);
	this.type = 'i';
	this._markModified();
};

EbmlElement.prototype.setUInt = function(uintValue) {
	this.data = utils.writeUInt(uintValue);
	this.type = 'u';
	this._markModified();
};

EbmlElement.prototype.setFloat = function(floatValue) {
	var buf4 = new Buffer(4);
	buf4.writeFloatBE(floatValue, 0);
	if (buf4.readFloatBE(0) === floatValue) {
		this.data = buf4;
	} else {
		var buf8 = new Buffer(8);
		buf8.writeDoubleBE(floatValue, 0);
		this.data = buf8;
	}
	this.type = 'f';
	this._markModified();
};

EbmlElement.prototype.setDateNanos = function(dateValueNanos) {
	this.setDate(dateValueNanos);
};

EbmlElement.prototype.setDate = function(dateValue) {
	var numValue;
	if (dateValue && typeof dateValue.getTime === 'function') {
		numValue = (dateValue.getTime() - EPOCH_TIME) * (1000 / 256) * (1000 / 256);
	} else if (typeof dateValue === 'number' && !isNaN(dateValue)) {
		numValue = dateValue / (256 * 256);
	} else {
		throw new Error("Invalid date value '" + dateValue + "'");
	}

	var buf = new Buffer(8);
	buf.writeUIntBE(numValue, 0, 6);
	this.type = 'd';
	this.data = buf;
	this._markModified();
};

EbmlElement.prototype.setData = function(dataValue) {
	this.data = Buffer.isBuffer(dataValue) ? dataValue : new Buffer(dataValue);
	this.type = 'b';
	this._markModified();
};

EbmlElement.prototype._markModified = function() {
	if (this._modified) return;

	this._modified = { start: this.start, end: this.end };
	this.start = undefined;
	this.end = undefined;
	this.length = undefined;
	this.lengthTagSize = undefined;

	if (this.parent) {
		this.parent._markModified();
	}
};

EbmlElement.prototype.setValue = function(val) {
	var valueType = typeof val;

	if (valueType === "string") {
		if (this.type === 's') this.setString(val);
		else this.setUTF8(val);
	} else if (valueType === "boolean") {
		this.setUInt(val ? 1 : 0);
	} else if (valueType === "number") {
		if (Math.floor(val) !== val) this.setFloat(val);
		else if (val >= 0) this.setUInt(val);
		else this.setInt(val);
	} else if (val && typeof val.getTime === 'function') {
		this.setDate(val);
	} else if (Buffer.isBuffer(val) || nodeUtil.isArray(val)) {
		this.setData(val);
	} else {
		throw new Error("Unsupported type of value (" + val + ")");
	}
};

EbmlElement.prototype.setTargetPosition = function(targetElement) {
	this._positionTarget = targetElement;
};

EbmlElement.prototype.setTargetEbmlID = function(id) {
	var targetId = (id && id.ebmlID) ? id.ebmlID : id;
	this.setData(utils.writeEbmlID(targetId));
};

EbmlElement.prototype._getSize = function() {
	if (!this._modified && this.start !== undefined) {
		nodeAssert(typeof this.end === "number", "End of #" + this.tagId + " is not a number");
		nodeAssert(typeof this.start === "number", "Start of #" + this.tagId + " is not a number");
		return this.end - this.start;
	}

	if (!this.masterType) {
		var sizeOfData = this.getDataSize();
		nodeAssert(typeof sizeOfData === "number", "Data size of #" + this.tagId + " is not a number");
		return utils.sizeHInt(this.ebmlID) + utils.sizeVInt(sizeOfData) + sizeOfData;
	}

	var childrenTotalSize = 0;
	if (this.children) {
		var idx = 0;
		var count = this.children.length;
		while (idx < count) {
			var childNode = this.children[idx];
			var childSize = childNode._getSize();
			nodeAssert(typeof childSize === "number", "Size of #" + childNode.tagId + " is not a number");
			childrenTotalSize += childSize;
			idx += 1;
		}
	}

	return utils.sizeHInt(this.ebmlID) + utils.sizeVInt(childrenTotalSize) + childrenTotalSize;
};

EbmlElement.prototype._optimizeData = function() {
	if (!this.data) return 0;
	var changed = 0;
	var currentLength = this.data.length;

	if (this.type === 'u') {
		var uVal = this.getUInt();
		if (utils.sizeUInt(uVal) !== currentLength) {
			this.setUInt(uVal);
			changed = 1;
		}
	} else if (this.type === 'i') {
		var iVal = this.getInt();
		if (utils.sizeInt(iVal) !== currentLength) {
			this.setInt(iVal);
			changed = 1;
		}
	} else if (this.type === 'f') {
		var fVal = this.getFloat();
		if (utils.sizeFloat(fVal) !== currentLength) {
			this.setFloat(fVal);
			changed = 1;
		}
	}
	return changed;
};

EbmlElement.prototype._write = function(outputStream, sourceHandler, completionCallback) {
	if (!this._modified && !this._dataSource) {
		sourceHandler.writeCompleteTag(outputStream, this, completionCallback);
		return;
	}

	var cachedEbmlID = this.schemaInfo._ebmlID;
	if (!cachedEbmlID) {
		cachedEbmlID = utils.writeUInt(this.ebmlID);
		this.schemaInfo._ebmlID = cachedEbmlID;
	}

	sourceHandler.writeHInt(outputStream, this.ebmlID);

	if (!this.masterType) {
		if (!this.data && this._dataSource) {
			sourceHandler.writeTagDataSource(outputStream, this.dataSize, this._dataSource, completionCallback);
		} else {
			sourceHandler.writeTagData(outputStream, this.data, completionCallback);
		}
		return;
	}

	var childNodes = this.children;
	if (!childNodes) {
		sourceHandler.writeVInt(outputStream, 0);
		return completionCallback();
	}

	var totalChildrenSize = 0;
	var i = 0;
	var len = childNodes.length;
	while (i < len) {
		totalChildrenSize += childNodes[i]._getSize();
		i += 1;
	}

	sourceHandler.writeVInt(outputStream, totalChildrenSize);

	nodeAsync.eachSeries(childNodes, function(childElement, next) {
		childElement._write(outputStream, sourceHandler, next);
	}, completionCallback);
};

EbmlElement.prototype._childrenPosition = function(targetPosition) {
	var elementStart = this.start;
	var elementEnd = this.end;
	var modificationInfo = this._modified;

	if (modificationInfo) {
		elementStart = modificationInfo.start;
		elementEnd = modificationInfo.end;
	}

	if (targetPosition < elementStart || targetPosition >= elementEnd) {
		return null;
	}
	if (targetPosition === elementStart) {
		return { position: "start", target: this };
	}

	var childNodes = this.children;
	if (childNodes) {
		var i = 0;
		var len = childNodes.length;
		while (i < len) {
			var childNode = childNodes[i];
			var positionInfo = childNode._childrenPosition(targetPosition);
			if (positionInfo) {
				return positionInfo;
			}
			i += 1;
		}
	}

	return { position: "middle", target: this };
};

EbmlElement.prototype.getTagByPosition = function(pos, useContentOffset) {
	var adjustedPosition = pos;
	if (useContentOffset) {
		adjustedPosition += this.getContentPosition();
	} else {
		adjustedPosition += this.getPosition();
	}
	return this._childrenPosition(adjustedPosition);
};

EbmlElement.prototype.remove = function() {
	if (!this.parent) {
		throw new Error("No parent !");
	}
	return this.parent.removeChild(this);
};

EbmlElement.prototype.removeChild = function(elementToRemove) {
	if (!this.children) return false;

	var index = this.children.indexOf(elementToRemove);
	if (index < 0) return false;

	this.children.splice(index, 1);
	elementToRemove.parent._markModified();
	elementToRemove.parent = null;

	var doc = this.ownerDocument;
	elementToRemove.deepWalk(function(el) {
		var sInfo = el.schemaInfo;
		if (!sInfo) return;
		if (el._positionTargetType) {
			el._positionTargetType = undefined;
			doc._unregisterPosition(el);
		}
		if (sInfo.crc) {
			doc._unregisterCRC(el);
		}
	});

	return true;
};

EbmlElement.prototype.appendChild = function(newChild, skipUpdate) {
	if (!this.masterType) {
		throw new Error("Element " + this._name + "/" + this.ebmlID + "/" + this.type + " is not a master type");
	}
	return this.insertBefore(newChild, null, skipUpdate);
};

EbmlElement.prototype.insertBefore = function(newChild, referenceChild, skipUpdate) {
	if (newChild.parent) {
		newChild.remove();
	}

	if (!this.children) {
		this.children = [];
	}

	var doc = this.ownerDocument;
	newChild.deepWalk(function(el) {
		var sInfo = el.schemaInfo;
		if (!sInfo) return;
		if (sInfo.position) {
			el._positionTargetType = sInfo.position;
			doc._registerPosition(el);
		}
		if (sInfo.crc) {
			doc._registerCRC(el);
		}
	});

	var inserted = false;
	if (referenceChild) {
		var refIndex = this.children.indexOf(referenceChild);
		if (refIndex >= 0) {
			this.children.splice(refIndex, 0, newChild);
			inserted = true;
		}
	}

	if (!inserted) {
		this.children.push(newChild);
	}

	newChild.parent = this;
	if (skipUpdate !== false) {
		this._markModified();
	}
};

EbmlElement.prototype.getLevel1 = function() {
	var current = this;
	while (current && current.parent) {
		if (current.parent.type === 'D') {
			return current;
		}
		current = current.parent;
	}
	return undefined;
};

EbmlElement.prototype.getPosition = function() {
	var parentElement = this.parent;
	if (!parentElement) return 0;

	var position = parentElement.getContentPosition();
	var siblings = parentElement.children;

	if (siblings) {
		var i = 0;
		var len = siblings.length;
		while (i < len) {
			var sibling = siblings[i];
			if (sibling === this) break;
			position += sibling._getSize();
			i += 1;
		}
	}
	return position;
};

EbmlElement.prototype.getContentPosition = function() {
	var parentElement = this.parent;
	if (!parentElement) return 0;

	var basePosition = this.getPosition() + utils.sizeHInt(this.ebmlID);

	if (!this.masterType) {
		return basePosition + utils.sizeVInt(this.getDataSize());
	}

	if (this.lengthTagSize) {
		return basePosition + this.lengthTagSize;
	}

	var childrenTotalSize = 0;
	if (this.children) {
		var i = 0;
		var len = this.children.length;
		while (i < len) {
			childrenTotalSize += this.children[i]._getSize();
			i += 1;
		}
	}
	return basePosition + utils.sizeVInt(childrenTotalSize);
};

EbmlElement.prototype.eachChild = function(iteratorFunc) {
	var childNodes = this.children;
	if (!childNodes || childNodes.length === 0) return;

	var i = 0;
	var len = childNodes.length;
	while (i < len) {
		iteratorFunc(childNodes[i], i);
		i += 1;
	}
};

EbmlElement.prototype.getDataStream = function(cb) {
	if (this.data) {
		var passThrough = new nodeStream.PassThrough();
		passThrough.end(this.data);
		cb(null, passThrough);
	} else if (this._dataSource) {
		this._dataSource.getStream(cb);
	} else {
		this.ownerDocument.source.getTagDataStream(this, cb);
	}
};

var updateCRC = function(crcObj, dataChunk) {
	crcObj.value = (crcObj.value === undefined) ? nodeCrc32(dataChunk) : nodeCrc32(dataChunk, crcObj.value);
};

var processStreamForCRC = function(inputStream, crcObj, cb) {
	inputStream.on('readable', function() {
		var chunk = inputStream.read();
		if (chunk) {
			updateCRC(crcObj, chunk);
		} else {
			cb(null);
		}
	});
	inputStream.on('error', cb);
};

EbmlElement.prototype.computeCRC = function(crcState, cb) {
	var currentCRC = crcState || {};
	var self = this;

	updateCRC(currentCRC, utils.writeUInt(this.ebmlID));

	if (this.masterType) {
		var childNodes = this.children;
		var childrenSize = 0;
		if (childNodes) {
			var i = 0;
			var len = childNodes.length;
			while (i < len) {
				childrenSize += childNodes[i]._getSize();
				i += 1;
			}
		}
		updateCRC(currentCRC, utils.writeVInt(childrenSize));

		if (childNodes) {
			setImmediate(function() {
				self._computeChildrenCRC(false, currentCRC, cb);
			});
		} else {
			cb(null, currentCRC.value);
		}
	} else {
		if (this.data) {
			updateCRC(currentCRC, utils.writeVInt(this.data.length));
			updateCRC(currentCRC, this.data);
			cb(null, currentCRC.value);
		} else {
			updateCRC(currentCRC, utils.writeVInt(this.dataSize));
			this.getDataStream(function(err, dataStream) {
				if (err) return cb(err);
				processStreamForCRC(dataStream, currentCRC, function(streamErr) {
					cb(streamErr, streamErr ? undefined : currentCRC.value);
				});
			});
		}
	}
};


EbmlElement.prototype.moveChildBefore = function(childToMove, referenceChild) {
	var childNodes = this.children;
	if (!childNodes) throw new Error("This tag has no children " + this);

	var moveIndex = childNodes.indexOf(childToMove);
	if (moveIndex < 0) throw new Error("Can not find the child '" + childToMove + "' parent=" + this);

	var referenceIndex;
	if (referenceChild === null || referenceChild === undefined) {
		if (moveIndex === childNodes.length - 1) return false;
		referenceIndex = childNodes.length;
	} else {
		referenceIndex = childNodes.indexOf(referenceChild);
		if (referenceIndex < 0) throw new Error("Can not find the before child '" + referenceChild + "' parent=" + this);
	}

	childNodes.splice(moveIndex, 1);
	var insertIndex = referenceIndex - ((moveIndex < referenceIndex) ? 1 : 0);
	childNodes.splice(insertIndex, 0, childToMove);

	this._markModified();
	return true;
};

EbmlElement.prototype._computeChildrenCRC = function(skipCRCTag, crcState, cb) {
	var currentCRC = crcState || {};
	var childNodes = this.children;

	if (!childNodes || childNodes.length === 0) {
		return cb(null, currentCRC.value);
	}

	nodeAsync.eachSeries(childNodes, function(childElement, next) {
		if (skipCRCTag && childElement.ebmlID === modelDefinitions.byName.CRC_32) {
			next(null);
		} else {
			childElement.computeCRC(currentCRC, next);
		}
	}, function(err) {
		cb(err, err ? undefined : currentCRC.value);
	});
};

EbmlElement.prototype.deepWalk = function(visitorFunc) {
	var result = visitorFunc(this);
	if (result !== undefined) return result;

	var nodes = this.children;
	if (!nodes) return undefined;

	var queue = nodes.slice();
	while (queue.length > 0) {
		var current = queue.shift();
		result = visitorFunc(current);
		if (result !== undefined) return result;

		if (current.children) {
			var childrenToAdd = [0, 0].concat(current.children);
			Array.prototype.splice.apply(queue, childrenToAdd);
		}
	}
	return undefined;
};

EbmlElement.prototype.toString = function() {
	return "[Element #" + this.tagId + "]";
};

EbmlElement.prototype.setMkvFormatDate = function(dt) {
	this.setUTF8(utils.formatDate(dt));
};

EbmlElement.prototype.isModified = function() {
	return this._modified !== null && this._modified !== undefined;
};

Object.defineProperty(EbmlElement.prototype, "firstChild", {
	enumerable: true,
	configurable: true,
	get: function() {
		var c = this.children;
		return (c && c.length) ? c[0] : null;
	}
});

Object.defineProperty(EbmlElement.prototype, "lastChild", {
	enumerable: true,
	configurable: true,
	get: function() {
		var c = this.children;
		return (c && c.length) ? c[c.length - 1] : null;
	}
});

Object.defineProperty(EbmlElement.prototype, "empty", {
	enumerable: true,
	configurable: true,
	get: function() {
		var c = this.children;
		return (!c || c.length === 0);
	}
});
