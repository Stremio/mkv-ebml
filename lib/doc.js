var asyncLib = require('async'); 
var fileSystem = require('fs'); 
var inherits = require('util').inherits; 
var crcCalculator = require('crc').crc32; 

var modelDefinitions = require('./model'); 
var BaseElement = require('./elem'); 
var utils = require('./utils'); 

var blocks = require('./blocks.js');

function MatroskaDocument() {
  this.type = "D";
  this._name = "Document";
  this.tagId = 0;
  this._nextTagId = 1;
  this.ownerDocument = this;
  this.masterType = true;
}

inherits(MatroskaDocument, BaseElement); 

MatroskaDocument.prototype.createElement = function(ebmlID, startPosition, elementLength) {
  var elementInstance;
  if (blocks[ebmlID]) {
    var ElementConstructor = blocks[ebmlID];
    elementInstance = new ElementConstructor(
      this,
      this._nextTagId++,
      startPosition,
      elementLength
    );
  } else {
    elementInstance = new BaseElement(
      this,
      this._nextTagId++,
      ebmlID,
      startPosition,
      elementLength
    );
  }
  return elementInstance;
};

function removeArrayItem(targetArray, itemToRemove) {
  if (!targetArray || !targetArray.length) {
    return false;
  }
  var itemIndex = targetArray.indexOf(itemToRemove);
  if (itemIndex < 0) {
    return false;
  }
  targetArray.splice(itemIndex, 1);
  return true;
}

MatroskaDocument.prototype._registerPosition = function(positionElement) {
  if (!this._positions) {
    this._positions = [];
  }
  this._positions.push(positionElement);
  if (this._modified) {
    positionElement._markModified();
  }
};

MatroskaDocument.prototype._unregisterPosition = function(positionElement) {
  return removeArrayItem(this._positions, positionElement);
};

MatroskaDocument.prototype._registerCRC = function(crcElement) {
  if (!this._crcs) {
    this._crcs = [];
  }
  this._crcs.push(crcElement);
};

MatroskaDocument.prototype._unregisterCRC = function(crcElement) {
  return removeArrayItem(this._crcs, crcElement);
};

MatroskaDocument.prototype._markModified = function() {
  if (this._modified) {
    return;
  }
  if (this._partial) {
    throw new Error("Cannot modify a partially parsed document");
  }
  this._modified = true;
  if (!this._positions) {
    return;
  }
  this._positions.forEach(function(childElement) {
    childElement._markModified();
  });
};

MatroskaDocument.prototype._buildLinks = function() {
  if (this._linksBuilt) {
    return;
  }
  this._linksBuilt = true;
  if (!this._positions) {
    return;
  }
  var documentInstance = this;
  this._positions.forEach(function(positionElement) {
    var positionValue = positionElement.getValue();
    var parentLevel1 = positionElement.getLevel1();
    var positionType = positionElement._positionTargetType;

    switch (positionType) {
      case "segment":
        break;
      case "clusterRelative":
        var clusterPosition = positionElement.parent.cueClusterPosition;
        if (!clusterPosition) {
          throw new Error("Invalid cluster relative without a cueClusterPosition");
        }
        positionValue += clusterPosition._positionTarget
          ? clusterPosition._positionTarget.getContentPosition()
          : clusterPosition;
        break;
      case "cluster":
      default:
        throw new Error("Unsupported position type: " + positionType);
    }

    var targetInfo = parentLevel1.getTagByPosition(positionValue, true);
    if (!targetInfo || targetInfo.position !== "start") {
      return;
    }
    positionElement._positionTarget = targetInfo.target;
  });
};

MatroskaDocument.prototype.write = function(outputTarget, writeOptions, completionCallback) {
  if (typeof writeOptions === "function" && arguments.length === 2) {
    completionCallback = writeOptions;
    writeOptions = null;
  }
  writeOptions = writeOptions || {};
  var documentInstance = this;
  if (this._partial) {
    return completionCallback(new Error("The document is not complete"));
  }

  this._prepareDocument(writeOptions, function(prepareError) {
    if (prepareError) {
      return completionCallback(prepareError);
    }
    documentInstance._computePositions(function(positionError) {
      if (positionError) {
        return completionCallback(positionError);
      }
      var sourceObject = documentInstance.source; 
      documentInstance._updateCRC32(function(crcError) {
        if (crcError) {
          return completionCallback(crcError);
        }
        var closeStreamWhenDone = false;
        if (typeof outputTarget === "string") {
          outputTarget = fileSystem.createWriteStream(outputTarget); 
          closeStreamWhenDone = true;
        }
        var writeContext = {
          stream: outputTarget,
          options: writeOptions
        };
        documentInstance._write(writeContext, sourceObject, function(writeError) {
          if (writeError) {
            return completionCallback(writeError);
          }
          
          if (sourceObject && typeof sourceObject.end === 'function') {
              sourceObject.end(writeContext, function(endError) {
                if (endError) {
                  return completionCallback(endError);
                }
                if (!closeStreamWhenDone) {
                  return completionCallback();
                }
                outputTarget.end(completionCallback);
              });
          } else {
              
              if (!closeStreamWhenDone) {
                return completionCallback();
              }
              outputTarget.end(completionCallback);
          }
        });
      });
    });
  });
};


MatroskaDocument.prototype._prepareDocument = function(options, callback) {
  return callback();
};

MatroskaDocument.prototype._write = function(outputContext, sourceObject, callback) {
  asyncLib.eachSeries(this.children, function(childElement, childCallback) { 
    childElement._write(outputContext, sourceObject, childCallback);
  }, callback);
};

MatroskaDocument.prototype._computePositions = function(estimatedSize, callback) {
  if (!this._positions || !this._positions.length) {
    return callback();
  }
  if (typeof estimatedSize === 'function') {
    callback = estimatedSize;
    estimatedSize = null;
  }
  if (!estimatedSize) {
    estimatedSize = 0;
    (this.children || []).forEach(function(childElement) { 
        var elementSize = childElement._getSize ? childElement._getSize() : 0; 
        estimatedSize += elementSize;
    });
  }

  var bitSize = utils.sizeUInt(estimatedSize) * 8; 
  var maxValue = Math.pow(2, bitSize) - 1;
  var hasError = false; 

  this._positions.forEach(function(positionElement) {
    positionElement.setUInt(maxValue); 
    var targetElement = positionElement._positionTarget;
    if (!targetElement) {
      console.warn("Warning: Position element has no target.", positionElement); 
      return;
    }

    var sourceLevel1 = positionElement.getLevel1(); 
    var targetLevel1 = targetElement.getLevel1();
    if (sourceLevel1 !== targetLevel1) {
      console.error("Error: Position target is not in the same segment level.", positionElement, targetElement);
      hasError = true; 
      return;
    }
  });

  if (hasError) {
    return callback(new Error("Error computing positions due to target issues."));
  }

  var iteration = 1;
  var maxIterations = 5; 
  var changesCount = 1; 

  for (; changesCount > 0 && iteration <= maxIterations; iteration++) {
    changesCount = 0;
    this._positions.forEach(function(positionElement) {
      var targetElement = positionElement._positionTarget;
      if (!targetElement) return; 

      var parentLevel1 = targetElement.getLevel1();
      
      var targetPosition = typeof targetElement.getPosition === 'function' ? targetElement.getPosition() : 0;
      var parentContentPosition = typeof parentLevel1.getContentPosition === 'function' ? parentLevel1.getContentPosition() : 0;

      var newPosition = targetPosition - parentContentPosition;
      var currentPosition = positionElement.getUInt(); 

      if (newPosition === currentPosition) {
        return;
      }

      positionElement.setUInt(newPosition);
      changesCount++;
    });
  }

  if (changesCount > 0 && iteration > maxIterations) {
      console.warn("Warning: Position calculation did not converge after " + maxIterations + " iterations.");
  }

  return callback(); 
};


MatroskaDocument.prototype._updateCRC32 = function(callback) {
  var crcElements = this._crcs;
  if (!crcElements || !crcElements.length) {
    return callback();
  }

  function calculateDepth(element) {
    var depth = 0;
    while (element && element.parent) { 
      depth++;
      element = element.parent;
    }
    return depth;
  }

  crcElements.sort(function(element1, element2) {
    return calculateDepth(element2) - calculateDepth(element1);
  });

  asyncLib.eachSeries(crcElements, function(crcElement, elementCallback) { 
    var parentElement = crcElement.parent;
    if (!parentElement) {
        
        return elementCallback(new Error("CRC element has no parent"));
    }

    parentElement._computeChildrenCRC(true, null, function(error, crcValue) {
      if (error) {
        return elementCallback(error);
      }
      if (crcElement.data) { 
        var oldCRC = crcElement.getCRCValue(); 
        if (crcValue == oldCRC) { 
          return elementCallback(); 
        }
      }
      crcElement.setCRCValue(crcValue); 
      elementCallback();
    });
  }, callback);
};


MatroskaDocument.prototype.getTagById = function(tagId) {
  if (isNaN(tagId)) {
    throw new Error("Invalid tag identifier: " + tagId);
  }
  
  var result = this.deepWalk(function(childElement) {
    if (childElement.tagId === tagId) {
      return childElement; 
    }
    
  });
  return result; 
};

MatroskaDocument.prototype.toString = function() {
  return "[Document source=" + (this.source || 'unknown') + "]";
};

function EnhancedMatroskaDocument() {
  MatroskaDocument.call(this); 
}

inherits(EnhancedMatroskaDocument, MatroskaDocument); 

EnhancedMatroskaDocument.prototype.getEBML = function() {
  return this.getFirstChildByName(modelDefinitions.byName.EBML);
};

EnhancedMatroskaDocument.prototype.getFirstSegment = function() {
  return this.getFirstChildByName(modelDefinitions.byName.Segment);
};

Object.defineProperty(EnhancedMatroskaDocument.prototype, "firstSegment", {
  enumerable: false,
  configurable: true,
  get: function getFirstSegmentProperty() {
    return this.getFirstSegment();
  }
});

Object.defineProperty(EnhancedMatroskaDocument.prototype, "head", {
  enumerable: false,
  configurable: true,
  get: function getHeadProperty() {
    return this.getEBML();
  }
});

Object.defineProperty(EnhancedMatroskaDocument.prototype, "segments", {
  enumerable: false,
  configurable: true,
  get: function getSegmentsProperty() {
    
    return this.listChildrenByName(modelDefinitions.byName.Segment);
  }
});

function AdvancedMatroskaDocument() {
  EnhancedMatroskaDocument.call(this); 
}

inherits(AdvancedMatroskaDocument, EnhancedMatroskaDocument); 

AdvancedMatroskaDocument.prototype.optimizeData = function(optimizationOptions, completionCallback) {
  if (arguments.length === 1 && typeof optimizationOptions === "function") {
    completionCallback = optimizationOptions;
    optimizationOptions = null;
  }
  if (!this.children) { 
    return completionCallback();
  }
  optimizationOptions = optimizationOptions || {};
  var optimizationCount = 0;

  this.deepWalk(function(element) {
      if (element && typeof element._optimizeData === 'function') { 
          var elementOptimizations = element._optimizeData(optimizationOptions);
          optimizationCount += elementOptimizations;
      }
  });

  return completionCallback(null); 
};

AdvancedMatroskaDocument.prototype.normalizeSegments = function(normalizationOptions, completionCallback) {
  var segmentElements = this.segments; 
  normalizationOptions = normalizationOptions || {};

  asyncLib.eachSeries(segmentElements, function(segmentElement, segmentCallback) {
      if (segmentElement && typeof segmentElement.normalize === 'function') { 
        segmentElement.normalize(normalizationOptions, segmentCallback);
      } else {
          console.warn("Segment element or normalize method missing", segmentElement);
          segmentCallback(); 
      }
  }, completionCallback);
};


AdvancedMatroskaDocument.prototype._prepareDocument = function(preparationOptions, completionCallback) {
  var processingSteps = [];
  var documentInstance = this;
  preparationOptions = preparationOptions || {};

  if (preparationOptions.normalizeSegments !== false) {
    processingSteps.push(function(stepCallback) {
      documentInstance.normalizeSegments(preparationOptions, stepCallback);
    });
  }

  if (preparationOptions.optimizeData !== false) {
    processingSteps.push(function(stepCallback) {
      documentInstance.optimizeData(preparationOptions, stepCallback);
    });
  }

  if (preparationOptions.forceStereoMode !== undefined) {
    (this.segments || []).forEach(function(segment) {
        if (segment && segment.tracks && segment.tracks.trackEntries) {
            segment.tracks.trackEntries.forEach(function(trackEntry) {
                try {
                    
                    if (trackEntry && trackEntry.video) {
                        var videoTrack = trackEntry.video;
                        
                        if ('stereoMode' in videoTrack) {
                             videoTrack.stereoMode = preparationOptions.forceStereoMode;
                        } else {
                            console.warn("TrackEntry video object does not have stereoMode property", videoTrack);
                        }
                    }
                } catch (error) {
                   console.error("Error setting stereoMode:", error);
                }
            });
        }
    });
  }

  asyncLib.series(processingSteps, function(error) {
    if (error) {
      return completionCallback(error);
    }
     EnhancedMatroskaDocument.prototype._prepareDocument.call(documentInstance, preparationOptions, completionCallback);
  });
};

module.exports = AdvancedMatroskaDocument;
