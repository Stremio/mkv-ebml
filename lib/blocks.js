var fileSystem = require('fs');
var inherits = require('util').inherits;
var crcGenerator = require('crc').crc32;
var modelDefinitions = require('./model');
var baseElementClass = require('./elem');
var mimeTypeHelper = require('mime');
var pathUtils = require('path');
var asyncLib = require('async');
var utils = require('./utils');

function _convertToLowerCamelCase(inputString) {
  var matchResult = /^([A-Z])([a-z].*)$/.exec(inputString);
  if (!matchResult) return inputString;
  return matchResult[1].toLowerCase() + matchResult[2];
}

function createAttributeAccessors(targetPrototype, elementName) {
  var elementId = modelDefinitions.byName[elementName];
  if (!elementId) {
    throw new Error("Cannot create accessors: Unknown EBML element '" + elementName + "'");
  }
  
  var elementSchema = modelDefinitions.byEbmlID[elementId];
  var elementType = elementSchema.type;
  var propertyName = _convertToLowerCamelCase(elementName);
  
  Object.defineProperty(targetPrototype, propertyName, {
    iterable: true,
    get: function elementGetter() {
      var targetChild = this.getFirstChildByName(elementId);
      if (!targetChild) return undefined;
      
      if (elementSchema.type2 === "ebmlID") {
        return targetChild.getUInt();
      }
      return targetChild.getValue();
    },
    set: function elementSetter(newValue) {
      var targetChild = this.getFirstChildByName(elementId);
      
      if (!targetChild) {
        targetChild = this.ownerDocument.createElement(elementId);
        this.appendChild(targetChild);
      }
      
      if (elementSchema.type2 === "ebmlID") {
        targetChild.setTargetEbmlID(newValue);
      } 
      else if (elementSchema.position) {
        targetChild.setTargetPosition(newValue);
      } 
      else {
        
        try {
          newValue = utils.validType(elementType, newValue);
        } 
        catch (validationError) {
          throw validationError;
        }
        
        targetChild.setValue(newValue);
      }

      return this;
    }
  });
  
  Object.defineProperty(targetPrototype, "$$" + propertyName, {
    iterable: false,
    get: function directChildGetter() {
      return this.getFirstChildByName(elementId);
    }
  });
  
  targetPrototype["get" + elementName] = function getterFactory() {
    var foundChild = this.getFirstChildByName(elementId);
    
    if (foundChild) {
      return foundChild;
    }
    
    var newChild = this.ownerDocument.createElement(elementId);
    this.appendChild(newChild);
    return newChild;
  };
}

function createChildMethods(targetPrototype, elementName) {
  var elementId = modelDefinitions.byName[elementName];
  if (!elementId) {
    throw new Error("Cannot create child methods: Unknown EBML element '" + elementName + "'");
  }
  
  var singularName = _convertToLowerCamelCase(elementName);
  
  var pluralName;
  var pluralMatch = /(.*)y$/.exec(singularName);
  if (pluralMatch) {
    pluralName = pluralMatch[1] + "ies";
  } else {
    pluralName = singularName + "s";
  }
  
  Object.defineProperty(targetPrototype, pluralName, {
    iterable: true,
    get: function collectionGetter() {
      return this.listChildrenByName(elementId);
    }
  });
  
  Object.defineProperty(targetPrototype, singularName, {
    iterable: true,
    get: function singularGetter() {
      return this.getFirstChildByName(elementId);
    }
  });
  
  Object.defineProperty(targetPrototype, "$" + singularName, {
    iterable: true,
    get: function factoryGetter() {
      var existingChild = this.getFirstChildByName(elementId);
      
      if (existingChild) {
        return existingChild;
      }
      
      var newChild = this.ownerDocument.createElement(elementId);
      this.appendChild(newChild);
      return newChild;
    }
  });
  
  targetPrototype["new" + elementName] = function createEmptyChild() {
    var newChild = this.ownerDocument.createElement(elementId);
    this.appendChild(newChild);
    return newChild;
  };
  
  targetPrototype["add" + elementName] = function createValueChild(initialValue) {
    var newChild = this.ownerDocument.createElement(elementId);
    this.appendChild(newChild);
    newChild.setValue(initialValue);
    return newChild;
  };
}

function createSingleChildMethods(targetPrototype, elementName) {
  
  var elementId = modelDefinitions.byName[elementName];
  if (!elementId) {
    throw new Error("Cannot create singleton methods: Unknown EBML element '" + elementName + "'");
  }
  
  var propertyName = _convertToLowerCamelCase(elementName);

  Object.defineProperty(targetPrototype, propertyName, {
    iterable: true,
    get: function mainGetter() {
      return this.getFirstChildByName(elementId);
    }
  });
  
  Object.defineProperty(targetPrototype, "$" + propertyName, {
    iterable: true,
    get: function factoryGetter() {
      var existingChild = this.getFirstChildByName(elementId);
      
      if (existingChild) {
        return existingChild;
      }
      
      var newChild = this.ownerDocument.createElement(elementId);
      this.appendChild(newChild);
      return newChild;
    }
  });
  
  targetPrototype["set" + elementName] = function replaceChild() {
    
    var existingChild = this.getFirstChildByName(propertyName);
    if (existingChild) {
      existingChild.remove();
    }
    
    var newChild = this.ownerDocument.createElement(elementId);
    this.appendChild(newChild);
    return newChild;
  };
}

function EnhancedElementType(documentContext, uniqueIdentifier, elementTypeId, bufferOffset, elementSize) {
  baseElementClass.call(
    this,
    documentContext,
    uniqueIdentifier,
    elementTypeId,
    bufferOffset,
    elementSize
  );
}

inherits(EnhancedElementType, baseElementClass);

var ParentElementType = function(documentReference, elementId, ebmlTypeId, startOffset, contentLength) {
  EnhancedElementType.call(
    this, 
    documentReference, 
    elementId, 
    ebmlTypeId, 
    startOffset, 
    contentLength
  );
}

inherits(ParentElementType, EnhancedElementType);

(function setupMasterElementPrototype() {
  createSingleChildMethods(
    ParentElementType.prototype, 
    "CRC_32"
  );
})();

var AttachedFileElement = function(documentRef, elementId, startPos, dataLen) {
  EnhancedElementType.call(this, documentRef, elementId, modelDefinitions.byName.AttachedFile, startPos, dataLen);
};

inherits(AttachedFileElement, EnhancedElementType);

AttachedFileElement.prototype.toString = function() {
  var result = "[AttachedFile #" + this.tagId + "]";
  return result;
};

(function(prototype) {
  var attributes = [
    "FileName",
    "FileMimeType",
    "FileDescription",
    "FileData",
    "FileUID"
  ];

  for (var i = 0; i < attributes.length; i++) {
    createAttributeAccessors(prototype, attributes[i]);
  }
})(AttachedFileElement.prototype);

function AttachmentsElement(documentInstance, idValue, startPosition, elementLength) {
  ParentElementType.call(
    this,
    documentInstance,
    idValue,
    modelDefinitions.byName.Attachments,
    startPosition,
    elementLength
  );
}

inherits(AttachmentsElement, ParentElementType);

AttachmentsElement.prototype.toString = function generateStringRepresentation() {
  var result = "[Attachments #" + this.tagId + "]";
  return result;
};

(function setupChildHandlers() {
  createChildMethods(
    AttachmentsElement.prototype,
    "AttachedFile"
  );
})();

function MatroskaAudioElement(documentReference, uniqueId, startOffset, dataLength) {
  EnhancedElementType.call(
    this,
    documentReference,
    uniqueId,
    modelDefinitions.byName.Audio,
    startOffset,
    dataLength
  );
}

inherits(MatroskaAudioElement, EnhancedElementType);

MatroskaAudioElement.prototype.toString = function debugRepresentation() {
  return "[Audio #" + this.tagId + "]";
};

(function configureAudioAttributes(prototype) {
  var attributes = [
    "SamplingFrequency",
    "OutputSamplingFrequency",
    "Channels",
    "BitDepth"
  ];

  attributes.forEach(function(attributeName) {
    createAttributeAccessors(prototype, attributeName);
  });
})(MatroskaAudioElement.prototype);

var DEFAULT_EMPTY_BUFFER = new Buffer([]);

function MatroskaCrc32Element(ownerDocument, elementId, startPosition, elementLength) {
  EnhancedElementType.call(
    this,
    ownerDocument,
    elementId,
    modelDefinitions.byName.CRC_32,
    startPosition,
    elementLength
  );

  this.data = DEFAULT_EMPTY_BUFFER;
  this.type = 'b';
}

inherits(MatroskaCrc32Element, EnhancedElementType);

MatroskaCrc32Element.prototype.toString = function getStringRepresentation() {
  return "[CRC-32 #" + this.tagId + "]";
};

function MatroskaCuePoint(documentContext, identifier, startPos, contentLength) {
  ParentElementType.call(
    this,
    documentContext,
    identifier,
    modelDefinitions.byName.CuePoint,
    startPos,
    contentLength
  );
}

inherits(MatroskaCuePoint, ParentElementType);

MatroskaCuePoint.prototype.toString = function getDebugString() {
  return "[CuePoint #" + this.tagId + "]";
};

(function setupCuePointPrototype(targetPrototype) {
  createAttributeAccessors(targetPrototype, "CueTime");
  createChildMethods(targetPrototype, "CueTrackPositions");
})(MatroskaCuePoint.prototype);

var MatroskaCueRef = function(documentObj, tagIdentifier, startOffset, lengthValue) {
  EnhancedElementType.call(
    this,
    documentObj,
    tagIdentifier,
    modelDefinitions.byName.CueReference,
    startOffset,
    lengthValue
  );
};

inherits(MatroskaCueRef, EnhancedElementType);

MatroskaCueRef.prototype.toString = function createDebugString() {
  return "[CueReference #" + this.tagId + "]";
};

(function setupAttributes() {
  createAttributeAccessors(
    MatroskaCueRef.prototype,
    "CueRefTime"
  );
})();

function MatroskaCues(documentContext, elementIdentifier, startPosition, elementSize) {
  ParentElementType.call(
    this,
    documentContext,
    elementIdentifier,
    modelDefinitions.byName.Cues,
    startPosition,
    elementSize
  );
}

inherits(MatroskaCues, ParentElementType);

MatroskaCues.prototype.toString = function createDebugString() {
  var identifier = this.tagId;
  return "[Cues #" + identifier + "]";
};

(function setupPrototype() {
  createChildMethods(
    MatroskaCues.prototype,
    "CuePoint"
  );
})();

function TrackPositionElement(docReference, elementId, startPosition, elementLength) {
  ParentElementType.call(
    this,
    docReference,
    elementId,
    modelDefinitions.byName.CueTrackPositions,
    startPosition,
    elementLength
  );
}

inherits(TrackPositionElement, ParentElementType);

TrackPositionElement.prototype.toString = function generateDebugString() {
  var idValue = this.tagId;
  return "[CueTrackPositions #" + idValue + "]";
};

(function initializePrototype() {
  var prototype = TrackPositionElement.prototype;

  var attributes = [
    "CueTrack",
    "CueClusterPosition",
    "CueRelativePosition",
    "CueDuration",
    "CueBlockNumber",
    "CueCodecState"
  ];

  attributes.forEach(function(attributeName) {
    createAttributeAccessors(prototype, attributeName);
  });

  createChildMethods(prototype, "CueReference");
})();

function SegmentInfoElement(documentRef, idValue, startPos, dataLength) {
  ParentElementType.call(
    this,
    documentRef,
    idValue,
    modelDefinitions.byName.Info,
    startPos,
    dataLength
  );
}

inherits(SegmentInfoElement, ParentElementType);

SegmentInfoElement.prototype.toString = function toDebugString() {
  return "[Info #" + this.tagId + "]";
};

(function initializeInfoPrototype() {
  var proto = SegmentInfoElement.prototype;

  var segmentIdentifiers = [
    "SegmentUID",
    "SegmentFilename",
    "PrevUID",
    "PrevFilename",
    "NextUID",
    "NextFilename",
    "SegmentFamily"
  ];

  var metadataAttributes = [
    "TimecodeScale",
    "Duration",
    "DateUTC",
    "Title",
    "MuxingApp",
    "WritingApp"
  ];

  segmentIdentifiers.concat(metadataAttributes).forEach(function(attrName) {
    createAttributeAccessors(proto, attrName);
  });

  createChildMethods(proto, "ChapterTranslate");
})();

var SeekElement = function(documentContext, elementIdentifier, bufferPosition, elementSize) {
  EnhancedElementType.call(
    this,
    documentContext,
    elementIdentifier,
    modelDefinitions.byName.Seek,
    bufferPosition,
    elementSize
  );
};

inherits(SeekElement, EnhancedElementType);

SeekElement.prototype.toString = function createDebugOutput() {
  var elementId = this.tagId;
  return "[Seek #" + elementId + "]";
};


(function initializeSeekAttributes() {
  var prototype = SeekElement.prototype;
  createAttributeAccessors(prototype, "SeekID");
  createAttributeAccessors(prototype, "SeekPosition");
})();

function MatroskaSeekHeadElement(rootDocument, uniqueId, startPosition, elementLength) {
  ParentElementType.call(
    this,
    rootDocument,
    uniqueId,
    modelDefinitions.byName.SeekHead,
    startPosition,
    elementLength
  );
}

inherits(MatroskaSeekHeadElement, ParentElementType);

MatroskaSeekHeadElement.prototype.toString = function createDebugString() {
  var tagIdentifier = this.tagId;
  return "[SeekHead #" + tagIdentifier + "]";
};

(function configureChildElements() {
  createChildMethods(
    MatroskaSeekHeadElement.prototype,
    "Seek"
  );
})();

function MatroskaSegmentHandler(documentRoot, elementID, startOffset, byteLength) {
  ParentElementType.call(
    this,
    documentRoot,
    elementID,
    modelDefinitions.byName.Segment,
    startOffset,
    byteLength
  );
}

inherits(MatroskaSegmentHandler, ParentElementType);

MatroskaSegmentHandler.prototype.toString = function getDebugString() {
  var idValue = this.tagId;
  return "[Segment #" + idValue + "]";
};

(function setupSegmentStructure() {
  var prototype = MatroskaSegmentHandler.prototype;
  var mainElements = [
    "Info",
    "SeekHead",
    "Attachments",
    "Tracks",
    "Tags"
  ];
  mainElements.forEach(function(elementName) {
    createSingleChildMethods(prototype, elementName);
  });
})();

function EnhancedSegment(docRef, tagIdentifier, startPosition, contentLength) {
  MatroskaSegmentHandler.call(this, docRef, tagIdentifier, startPosition, contentLength);
}
inherits(EnhancedSegment, MatroskaSegmentHandler);

function ensureValidCRC(targetElement) {
  if (!targetElement.children) {
    return;
  }
  var elementChildren = targetElement.children || [];
  var crcFound = false;
  elementChildren.forEach(function(childElement) {
    if (childElement.ebmlID !== modelDefinitions.byName.CRC_32) {
      return;
    }
    if (elementChildren[0] === childElement) {
      crcFound = true;
      return;
    }
    childElement.remove();
  });
  if (!crcFound) {
    targetElement.$crc_32 = 0;
  }
}

function ensureSeekReference(seekHeadList, elementToReference) {
  seekHeadList.forEach(function(seekHeadElement) {
    var referenceExists = false;
    seekHeadElement.seeks.forEach(function(seekElement) {
      var referencedId = seekElement.seekID;
      if (referencedId === elementToReference.ebmlID) {
        referenceExists = true;
        return false;
      }
    });
    if (referenceExists) {
      return;
    }
    var newSeekElement = seekHeadElement.newSeek();
    newSeekElement.seekID = elementToReference.ebmlID;
    newSeekElement.seekPosition = elementToReference;
  });
}

EnhancedSegment.prototype.normalize = function segmentNormalizer(options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = null;
  }
  options = options || {};
  var segmentElement = this;
  var firstCluster = this.getFirstChildByName(modelDefinitions.byName.Cluster);
  var allSeekHeads = this.listChildrenByName(modelDefinitions.byName.SeekHead);

  allSeekHeads.forEach(function(seekHead) {
    segmentElement.moveChildBefore(seekHead, firstCluster);
    ensureValidCRC(seekHead);
  });

  this.eachChildByName(modelDefinitions.byName.Info, function(infoElement) {
    segmentElement.moveChildBefore(infoElement, firstCluster);
    ensureValidCRC(infoElement);
    ensureSeekReference(allSeekHeads, infoElement);
  });

  this.eachChildByName(modelDefinitions.byName.Tracks, function(tracksElement) {
    segmentElement.moveChildBefore(tracksElement, firstCluster);
    ensureValidCRC(tracksElement);
    ensureSeekReference(allSeekHeads, tracksElement);
  });

  this.eachChildByName(modelDefinitions.byName.Cues, function(cuesElement) {
    segmentElement.moveChildBefore(cuesElement, firstCluster);
    ensureValidCRC(cuesElement);
    ensureSeekReference(allSeekHeads, cuesElement);
  });

  this.eachChildByName(modelDefinitions.byName.Void, function(voidElement) {
    voidElement.remove();
  });

  this.eachChildByName(modelDefinitions.byName.Tags, function(tagsElement) {
    segmentElement.moveChildBefore(tagsElement, null);
    ensureValidCRC(tagsElement);
    ensureSeekReference(allSeekHeads, tagsElement);
  });

  this.eachChildByName(modelDefinitions.byName.Attachments, function(attachmentsElement) {
    segmentElement.moveChildBefore(attachmentsElement, null);
    ensureValidCRC(attachmentsElement);
    ensureSeekReference(allSeekHeads, attachmentsElement);
  });

  this.eachChildByName(modelDefinitions.byName.AttachedFile, function(attachedFile) {
    ensureValidCRC(attachedFile);
  });

  if (typeof callback === 'function') {
      callback();
  }
};

function AdvancedSegment(documentRef, elementId, startPosition, elementLength) {
  EnhancedSegment.call(this, documentRef, elementId, startPosition, elementLength);
}
inherits(AdvancedSegment, EnhancedSegment);

function findMatchingTag(segment, criteria) {
  var tags = segment.listChildrenByName(modelDefinitions.byName.Tag);
  for (var i = 0; i < tags.length; i++) {
    var currentTag = tags[i];
    var tagTargets = currentTag.targets;

    if (!tagTargets || tagTargets.empty) {
      if (!criteria) {
        return currentTag;
      }
      continue;
    }

    if (criteria.targetTypeValue !== undefined &&
        criteria.targetTypeValue !== tagTargets.targetTypeValue) {
      continue;
    }
    if (criteria.targetType !== undefined &&
        criteria.targetType !== tagTargets.targetType) {
      continue;
    }

    var trackUIDs = tagTargets.tagTrackUIDs;
    if (criteria.tagTrackUID !== undefined) {
      if (!isTargetInList(criteria.tagTrackUID, trackUIDs)) {
        continue;
      }
    } else if (trackUIDs && trackUIDs.length) {
      continue;
    }

    var editionUIDs = tagTargets.tagEditionUIDs;
    if (criteria.tagEditionUID !== undefined) {
      if (!isTargetInList(criteria.tagEditionUID, editionUIDs)) {
        continue;
      }
    } else if (editionUIDs && editionUIDs.length) {
      continue;
    }

    var chapterUIDs = tagTargets.tagChapterUIDs;
    if (criteria.tagChapterUID !== undefined) {
      if (!isTargetInList(criteria.tagChapterUID, chapterUIDs)) {
        continue;
      }
    } else if (chapterUIDs && chapterUIDs.length) {
      continue;
    }

    var attachmentUIDs = tagTargets.tagAttachmentUIDs;
    if (criteria.tagAttachmentUID !== undefined) {
      if (!isTargetInList(criteria.tagAttachmentUID, attachmentUIDs)) {
        continue;
      }
    } else if (attachmentUIDs && attachmentUIDs.length) {
      continue;
    }
    return currentTag;
  }
  return undefined;
}

function isTargetInList(targetId, elementList) {
  if (!elementList || !elementList.length) {
    return false;
  }
  for (var i = 0; i < elementList.length; i++) {
    if (elementList[i].getValue() === targetId) {
      return true;
    }
  }
  return false;
}

AdvancedSegment.prototype.addFileAttachment = function(filePath, fileDescription, fileMimeType, attachmentName, callback) {
  if (typeof fileDescription === "function" && arguments.length === 2) {
    callback = fileDescription; fileDescription = undefined;
  } else if (typeof fileMimeType === "function" && arguments.length === 3) {
    callback = fileMimeType; fileMimeType = undefined;
  } else if (typeof attachmentName === "function" && arguments.length === 4) {
    callback = attachmentName; attachmentName = undefined;
  }

  if (typeof callback !== "function") {
    try {
        return this.addFileAttachmentSync(filePath, fileDescription, fileMimeType, attachmentName);
    } catch (e) {
        throw e;
    }
  }

  if (typeof filePath !== 'string' || !filePath) {
    process.nextTick(function() {
        callback("Invalid path '" + filePath + "'");
    });
    return;
  }

  var self = this;
  fileSystem.stat(filePath, function(error, fileStats) {
    if (error) {
      return callback(error);
    }
    if (!attachmentName) {
      attachmentName = pathUtils.basename(filePath);
    }
    if (!fileMimeType) {
      fileMimeType = mimeTypeHelper.lookup(filePath);
    }
    var newAttachment = self._addAttachment({
      path: filePath,
      description: fileDescription,
      size: fileStats.size,
      fileName: attachmentName,
      mimeType: fileMimeType,
      date: fileStats.mtime
    });
    callback(null, newAttachment);
  });
};

AdvancedSegment.prototype.addFileAttachmentSync = function(filePath, fileDescription, fileMimeType, attachmentName) {
  if (typeof filePath !== 'string' || !filePath) {
    throw new Error("Invalid path '" + filePath + "'");
  }
  var fileStats = fileSystem.statSync(filePath);
  if (!attachmentName) {
    attachmentName = pathUtils.basename(filePath);
  }
  if (!fileMimeType) {
    fileMimeType = mimeTypeHelper.lookup(filePath);
  }
  return this._addAttachment({
    path: filePath,
    description: fileDescription,
    size: fileStats.size,
    fileName: attachmentName,
    mimeType: fileMimeType,
    date: fileStats.mtime
  });
};

AdvancedSegment.prototype.addStreamAttachment = function(dataStream, fileName, mimeType, dataSize, description, callback) {
  if (typeof dataSize !== 'number') {
     process.nextTick(function() {
        callback("Invalid size for attachment '" + dataSize + "'");
    });
    return;
  }
  if (typeof mimeType !== 'string' || !mimeType.length) {
     process.nextTick(function() {
        callback("Invalid mimeType for attachment '" + mimeType + "'");
    });
    return;
  }
  if (typeof fileName !== 'string' || !fileName.length) {
     process.nextTick(function() {
        callback("Invalid fileName for attachment '" + fileName + "'");
    });
    return;
  }

  if (typeof description === "function") {
    callback = description;
    description = undefined;
  }

  if (typeof callback !== 'function') {
      throw new Error("Callback function is required for addStreamAttachment");
  }

  var newAttachment = this._addAttachment({
    stream: dataStream,
    description: description,
    size: dataSize,
    fileName: fileName,
    mimeType: mimeType
  });

  process.nextTick(function() {
     callback(null, newAttachment);
  });
};


AdvancedSegment.prototype._addAttachment = function(attachmentInfo) {
  var documentOwner = this.ownerDocument;
  var attachmentsContainer = this.$attachments;
  var newAttachment = attachmentsContainer.$attachedFile;
  newAttachment.$crc_32 = 0;
  newAttachment.fileName = attachmentInfo.fileName;
  newAttachment.fileMimeType = attachmentInfo.mimeType;

  if (attachmentInfo.description) {
    newAttachment.fileDescription = attachmentInfo.description;
  }

  var uniqueId = crcGenerator(
    attachmentInfo.fileName + "$" +
    attachmentInfo.mimeType + "$" +
    attachmentInfo.description + "$" +
    attachmentInfo.size
  );
  newAttachment.fileUID = uniqueId;

  var fileDataElement = newAttachment.getFileData();
  fileDataElement.dataSize = attachmentInfo.size;

  var streamProducer;
  var sourceInfo;

  if (typeof attachmentInfo.stream === "function") {
    streamProducer = attachmentInfo.stream;
    sourceInfo = "*function*";
  } else if (attachmentInfo.path) {
    streamProducer = function(streamOptions, streamCallback) {
      var fileStream = fileSystem.createReadStream(attachmentInfo.path, streamOptions);
      fileStream.on('error', function(err) {
         streamCallback(err);
      });
      process.nextTick(function() {
          streamCallback(null, fileStream);
      });
    };
    sourceInfo = attachmentInfo.path;
  } else {

      throw new Error("Attachment source (stream or path) is required.");
  }


  fileDataElement._dataSource = {
    getStream: streamProducer,
    info: sourceInfo
  };

  return newAttachment;
};


AdvancedSegment.prototype.getAttachmentByFileName = function(filename) {
  return this.eachChildByName(modelDefinitions.byName.AttachedFile, function(attachment) {
    var filenameElement = attachment.getFirstChildByName(modelDefinitions.byName.FileName);
    if (filenameElement && filenameElement.getValue() === filename) {
      return attachment;
    }
  });
};

AdvancedSegment.prototype.getAttachmentByFileUID = function(fileUID) {
  return this.eachChildByName(modelDefinitions.byName.AttachedFile, function(attachment) {
    var uidElement = attachment.getFirstChildByName(modelDefinitions.byName.FileUID);
    if (uidElement && uidElement.getValue() === fileUID) {
      return attachment;
    }
  });
};

AdvancedSegment.prototype.getTagByTargetType = function(targetCriteria) {
  return findMatchingTag(this, targetCriteria);
};

AdvancedSegment.prototype.addSimpleTagSync = function(targetInfo, tagName, language, isDefaultLanguage, tagValue) {
  var targetTag;

  if (targetInfo && targetInfo.ebmlID === modelDefinitions.byName.SimpleTag) {
    targetTag = targetInfo;
  } else {
    targetTag = this.getTagByTargetType(targetInfo);
    if (!targetTag) {
      targetTag = this.$tags.newTag();
      var tagTargets = targetTag.$targets;
      if (targetInfo) {
        if (targetInfo.tagAttachmentUID) {
          tagTargets.addTagAttachmentUID(targetInfo.tagAttachmentUID);
        }
        if (targetInfo.targetTypeValue) {
          tagTargets.targetTypeValue = targetInfo.targetTypeValue;
        }
        if (targetInfo.targetType) {
          tagTargets.targetType = targetInfo.targetType;
        }
      }
    }
  }

  var newSimpleTag = targetTag.newSimpleTag();
  newSimpleTag.tagName = tagName;
  newSimpleTag.tagLanguage = language || "und";
  newSimpleTag.tagDefault = isDefaultLanguage ? 1 : 0;

  if (tagValue === null || tagValue === undefined) {
    return newSimpleTag;
  }

  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(tagValue)) {
    newSimpleTag.tagBinary = tagValue;
    return newSimpleTag;
  }

  if (tagValue instanceof Date && typeof utils !== 'undefined' && utils.formatDate) {
    tagValue = utils.formatDate(tagValue);
  }

  tagValue = String(tagValue);
  newSimpleTag.tagString = tagValue;

  return newSimpleTag;
};

function TopLevelSegment(documentContext, tagIdentifier, startOffset, elementLength) {
  AdvancedSegment.call(
    this,
    documentContext,
    tagIdentifier,
    startOffset,
    elementLength
  );
}
inherits(TopLevelSegment, AdvancedSegment);

TopLevelSegment.prototype.findTagByName = function searchTagByName(tagName) {
  console.warn("TopLevelSegment.prototype.findTagByName is not implemented.");
  return undefined;
};

function SimpleTagElement(documentContext, elementId, bufferPosition, elementSize) {
  ParentElementType.call(
    this,
    documentContext,
    elementId,
    modelDefinitions.byName.SimpleTag,
    bufferPosition,
    elementSize
  );
}

inherits(SimpleTagElement, ParentElementType);

SimpleTagElement.prototype.toString = function getDebugString() {
  var idValue = this.tagId;
  return "[SimpleTag #" + idValue + "]";
};

(function configureSimpleTagPrototype() {
  var proto = SimpleTagElement.prototype;
  createChildMethods(proto, "SimpleTag");

  var attributes = [
    "TagName",
    "TagLanguage",
    "TagDefault",
    "TagString",
    "TagBinary"
  ];

  attributes.forEach(function(attributeName) {
    createAttributeAccessors(proto, attributeName);
  });
})();

function TagElement(documentRef, elementId, startPosition, contentLength) {
  ParentElementType.call(
    this,
    documentRef,
    elementId,
    modelDefinitions.byName.Tag,
    startPosition,
    contentLength
  );
}

inherits(TagElement, ParentElementType);

TagElement.prototype.toString = function createDebugRepresentation() {
  return "[Tag #" + this.tagId + "]";
};

(function setupTagElementStructure() {
  var prototype = TagElement.prototype;
  createSingleChildMethods(prototype, "Targets", true);
  createChildMethods(prototype, "SimpleTag");
})();

function TagsCollectionElement(docContext, elemId, startPos, dataSize) {

  ParentElementType.call(
    this,
    docContext,
    elemId,
    modelDefinitions.byName.Tags,
    startPos,
    dataSize
  );
}

inherits(TagsCollectionElement, ParentElementType);

TagsCollectionElement.prototype.toString = function getDebugString() {
  var elementId = this.tagId;
  return "[Tags #" + elementId + "]";
};


(function initializeTagsPrototype() {
  var prototype = TagsCollectionElement.prototype;
  createChildMethods(prototype, "Tag");
})();

function TagTargetsElement(documentOwner, elementId, startOffset, contentLength) {

  ParentElementType.call(
    this,
    documentOwner,
    elementId,
    modelDefinitions.byName.Targets,
    startOffset,
    contentLength
  );
}

inherits(TagTargetsElement, ParentElementType);

TagTargetsElement.prototype.toString = function getDebugString() {
  return "[Targets #" + this.tagId + "]";
};

(function setupTargetsPrototype() {
  var targetProto = TagTargetsElement.prototype;

  var attributes = [
    "TargetTypeValue",
    "TargetType"
  ];

  attributes.forEach(function(attributeName) {
    createAttributeAccessors(targetProto, attributeName);
  });

  var targetReferences = [
    "TagTrackUID",
    "TagEditionUID",
    "TagChapterUID",
    "TagAttachmentUID"
  ];

  targetReferences.forEach(function(childName) {
    createChildMethods(targetProto, childName);
  });
})();

function MediaTrackElement(documentContext, elementId, startPosition, elementSize) {
  ParentElementType.call(
    this,
    documentContext,
    elementId,
    modelDefinitions.byName.TrackEntry,
    startPosition,
    elementSize
  );
}

inherits(MediaTrackElement, ParentElementType);

MediaTrackElement.prototype.toString = function getDebugString() {
  return "[TrackEntry #" + this.tagId + "]";
};


(function configureTrackEntryPrototype() {
  var prototype = MediaTrackElement.prototype;

  var identificationAttributes = [
    "TrackNumber",
    "TrackUID",
    "TrackType"
  ];

  var flagAttributes = [
    "FlagEnabled",
    "FlagDefault",
    "FlagForced",
    "FlagLacing",
  ];

  var cachingAttributes = [
    "MinCache",
    "MaxCache"
  ];

  var timingAttributes = [
    "DefaultDuration",
    "DefaultDecodedFieldDuration",
    "CodecDelay",
    "SeekPreRoll"
  ];

  var descriptionAttributes = [
    "Name",
    "CodecID",
    "CodecPrivate",
    "CodecName",
    "AttachmentLink"
  ];

  var miscAttributes = [
    "MaxBlockAdditionID",
    "CodecDecodeAll",
    "TrackOverlay"
  ];

  var allAttributes = [].concat(
    identificationAttributes,
    flagAttributes,
    cachingAttributes,
    timingAttributes,
    descriptionAttributes,
    miscAttributes
  );

  allAttributes.forEach(function(attributeName) {
    createAttributeAccessors(prototype, attributeName);
  });

  var multipleChildren = [
    "TrackTranslate",
    "TrackOperation",
    "ContentEncodings"
  ];

  multipleChildren.forEach(function(childName) {
    createChildMethods(prototype, childName);
  });


  var singletonChildren = [
    "Video",
    "Audio"
  ];

  singletonChildren.forEach(function(childName) {
    createSingleChildMethods(prototype, childName);
  });
})();

function TracksCollectionElement(documentRef, tagIdentifier, startOffset, elementLength) {
  ParentElementType.call(
    this,
    documentRef,
    tagIdentifier,
    modelDefinitions.byName.Tracks,
    startOffset,
    elementLength
  );
}

inherits(TracksCollectionElement, ParentElementType);

TracksCollectionElement.prototype.toString = function getDebugRepresentation() {
  var identifier = this.tagId;
  return "[Tracks #" + identifier + "]";
};

(function setupTracksStructure() {
  var prototype = TracksCollectionElement.prototype;
  createChildMethods(prototype, "TrackEntry");
})();

function VideoTrackElement(documentContext, elementId, startPosition, elementSize) {
  EnhancedElementType.call(
    this,
    documentContext,
    elementId,
    modelDefinitions.byName.Video,
    startPosition,
    elementSize
  );
}

inherits(VideoTrackElement, EnhancedElementType);

VideoTrackElement.prototype.toString = function createDebugString() {
  var identifierValue = this.tagId;
  return "[Video #" + identifierValue + "]";
};

(function setupVideoPrototype() {
  var prototype = VideoTrackElement.prototype;

  var flagAttributes = [
    "FlagInterlaced",
    "StereoMode",
    "AlphaMode"
  ];

  var dimensionAttributes = [
    "PixelWidth",
    "PixelHeight",
    "PixelCropBottom",
    "PixelCropTop",
    "PixelCropLeft",
    "PixelCropRight"
  ];

  var displayAttributes = [
    "DisplayWidth",
    "DisplayHeight",
    "DisplayUnit",
    "AspectRatioType",
    "ColourSpace"
  ];

  var allAttributes = [].concat(
    flagAttributes,
    dimensionAttributes,
    displayAttributes
  );

  allAttributes.forEach(function registerAttribute(attributeName) {
    createAttributeAccessors(prototype, attributeName);
  });
})();

var blocks = {};

blocks[modelDefinitions.byName.AttachedFile] = AttachedFileElement;
blocks[modelDefinitions.byName.Attachments] = AttachmentsElement;
blocks[modelDefinitions.byName.Audio] = MatroskaAudioElement;
blocks[modelDefinitions.byName.CRC_32] = MatroskaCrc32Element;
blocks[modelDefinitions.byName.CuePoint] = MatroskaCuePoint;
blocks[modelDefinitions.byName.CueReference] = MatroskaCueRef;
blocks[modelDefinitions.byName.Cues] = MatroskaCues;
blocks[modelDefinitions.byName.CueTrackPositions] = TrackPositionElement;
blocks[modelDefinitions.byName.Info] = SegmentInfoElement;
blocks[modelDefinitions.byName.Seek] = SeekElement;
blocks[modelDefinitions.byName.SeekHead] = MatroskaSeekHeadElement;
blocks[modelDefinitions.byName.Segment] = TopLevelSegment;
blocks[modelDefinitions.byName.SimpleTag] = SimpleTagElement;
blocks[modelDefinitions.byName.Tag] = TagElement;
blocks[modelDefinitions.byName.Tags] = TagsCollectionElement;
blocks[modelDefinitions.byName.Targets] = TagTargetsElement;
blocks[modelDefinitions.byName.TrackEntry] = MediaTrackElement;
blocks[modelDefinitions.byName.Tracks] = TracksCollectionElement;
blocks[modelDefinitions.byName.Video] = VideoTrackElement;

module.exports = blocks;
