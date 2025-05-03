var fileSystem = require('fs');
var urlUtils = require('url');
var bufferModule = require('buffer');
var nodeUtil = require('util');
var streamModule = require('stream');

var DocumentClass = require('./doc');

var utils = require('./utils');
var modelDefinitions = require('./model');
var strictCheck = require('assert'); 
var httpClient = require('follow-redirects').http; 
var httpsClient = require('follow-redirects').https; 

function MatroskaDataSource() {}

var BUFFER_FLUSH_THRESHOLD = 65536;

function MatroskaSourceBase() {
  this._dataBuffers = [];
  this._bufferDataSize = 0;
}

nodeUtil.inherits(MatroskaSourceBase, MatroskaDataSource);

MatroskaSourceBase.prototype.writeCompleteTag = function(sessionContext, targetTag, completionCallback) {
  strictCheck(typeof targetTag.start === "number", "Missing start position for tag #" + targetTag.tagId);
  strictCheck(typeof targetTag.end === "number", "Missing end position for tag #" + targetTag.tagId);

  var sourceInstance = this;

  this._flushBuffers(sessionContext, function(flushError) {
    if (flushError) {
      return completionCallback(flushError);
    }

    var startOffset = targetTag.start;
    var endOffset = targetTag.end;

    if (targetTag._modified) {
      startOffset = targetTag._modified.start;
      endOffset = targetTag._modified.end;
    }

    sourceInstance.getStream(sessionContext, { 
      start: startOffset,
      end: endOffset - 1
    }, function(streamError, dataStream) {
      if (streamError) {
        return completionCallback(streamError);
      }

      dataStream.on('end', completionCallback);
      dataStream.on('error', completionCallback);

      dataStream.pipe(sessionContext.stream, {
        end: false
      });
    });
  });
};

MatroskaSourceBase.prototype.writeTagData = function(sessionContext, dataBuffer, completionCallback) {
  if (!dataBuffer) {
    
    setImmediate(function() {
      completionCallback(new Error("Cannot write null or undefined data"));
    });
    return;
  }

  this.writeVInt(sessionContext, dataBuffer.length);

  if (this._bufferDataSize + dataBuffer.length < BUFFER_FLUSH_THRESHOLD) {
    this._dataBuffers.push(dataBuffer);
    this._bufferDataSize += dataBuffer.length;

    setImmediate(completionCallback);
    return;
  }

  var sourceInstance = this;
  this._flushBuffers(sessionContext, function(flushError) {
    if (flushError) {
      return completionCallback(flushError);
    }

    sessionContext.stream.write(dataBuffer, completionCallback);
  });
};

MatroskaSourceBase.prototype.writeTagDataSource = function(sessionContext, contentSize, contentSource, completionCallback) {
  this.writeVInt(sessionContext, contentSize);

  var sourceInstance = this;

  this._flushBuffers(sessionContext, function(flushError) {
    if (flushError) {
      return completionCallback(flushError);
    }

    contentSource.getStream(sessionContext, function(streamError, dataStream) {
      if (streamError) {
        return completionCallback(streamError);
      }

      dataStream.on('error', completionCallback);
      dataStream.on('end', completionCallback);

      dataStream.pipe(sessionContext.stream, {
        end: false
      });
    });
  });
};

MatroskaSourceBase.prototype.writeVInt = function(sessionContext, integerValue) {
  if (typeof integerValue !== "number") {
    throw new Error("Cannot write non-numeric value: " + integerValue);
  }

  var encodedBuffer = utils.writeVInt(integerValue);

  this._dataBuffers.push(encodedBuffer);
  this._bufferDataSize += encodedBuffer.length;
};

MatroskaSourceBase.prototype.writeHInt = function(sessionContext, integerValue) {
  if (typeof integerValue !== "number" && !Buffer.isBuffer(integerValue)) {
    throw new Error("Cannot write invalid value: " + integerValue);
  }

  var bufferToWrite = integerValue;

  if (!Buffer.isBuffer(bufferToWrite)) {
    bufferToWrite = utils.writeUInt(integerValue);
  }

  this._dataBuffers.push(bufferToWrite);
  this._bufferDataSize += bufferToWrite.length;
};

MatroskaSourceBase.prototype._flushBuffers = function(sessionContext, completionCallback) {
  if (!this._bufferDataSize) {
    return setImmediate(completionCallback);
  }

  var outputBuffer;

  if (this._dataBuffers.length === 1) {
    outputBuffer = this._dataBuffers[0];
  } else {
    outputBuffer = Buffer.concat(this._dataBuffers);
  }

  this._dataBuffers = [];
  this._bufferDataSize = 0;

  sessionContext.stream.write(outputBuffer, completionCallback);
};

MatroskaSourceBase.prototype.getTagDataStream = function(targetTag, completionCallback) {
  var endPosition = targetTag.end;
  if (targetTag._modified) {
    endPosition = targetTag._modified.end;
  }

  var startPosition = endPosition - targetTag.getDataSize();

  this.getStream({}, {
    start: startPosition,
    end: endPosition - 1
  }, function(streamError, dataStream) {
    if (streamError) {
      return completionCallback(streamError);
    }

    completionCallback(null, dataStream);
  });
};

MatroskaSourceBase.prototype.end = function(sessionContext, completionCallback) {
  var sourceInstance = this;

  this._flushBuffers(sessionContext, function(flushError) {
    if (flushError) {
      return completionCallback(flushError);
    }
    sourceInstance._end(sessionContext, completionCallback);
  });
};


MatroskaSourceBase.prototype._end = function(sessionContext, completionCallback) {
  setImmediate(completionCallback);
};

MatroskaSourceBase.prototype.release = function(completionCallback) {
  this.end(this, completionCallback);
};

var DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.2; Trident/6.0; MSAppHost/1.0)';
var requestIdentifierCounter = 0;

function MkvHttpReader(targetUrl, configOptions) {
  MatroskaSourceBase.call(this);
  this.targetUrl = targetUrl;
  this.configOptions = configOptions || {};
}

nodeUtil.inherits(MkvHttpReader, MatroskaSourceBase);

MkvHttpReader.prototype.getStream = function(sessionContext, requestParams, completionCallback) {

  sessionContext = sessionContext || {};
  requestParams = requestParams || {};

  sessionContext.$httpSourceKey = requestIdentifierCounter++; 

  var requestOptions = urlUtils.parse(this.targetUrl);
  requestOptions.headers = requestOptions.headers || {};

  requestOptions.headers['User-Agent'] = this.configOptions.userAgent || DEFAULT_USER_AGENT;

  if (typeof requestParams.start === 'number') {
    var rangeValue = 'bytes=' + requestParams.start + '-';
    if (typeof requestParams.end === 'number') {
      rangeValue += requestParams.end;
    }
    requestOptions.headers.Range = rangeValue;
  }

  var client = (requestOptions.protocol === 'https:') ? httpsClient : httpClient;
  var sourceUrl = this.targetUrl; 

  var httpRequest = client.get(requestOptions, function(httpResponse) {
    if (Math.floor(httpResponse.statusCode / 100) !== 2) {
        httpResponse.resume(); 
        return completionCallback(new Error(
            "HTTP request failed: status=" + httpResponse.statusCode +
            ", message='" + (httpResponse.statusMessage || 'Unknown') + "'" + 
            ", url=" + sourceUrl
        ));
    }

    if (typeof requestParams.start === 'number') {
        var contentRangeHeader = httpResponse.headers['content-range'];
        var receivedPosition = null;

        if (contentRangeHeader) {
            var rangeMatch = /bytes (\d+)-(\d+)\/(\*|\d+)/.exec(contentRangeHeader);
             if (rangeMatch) {
                receivedPosition = parseInt(rangeMatch[1], 10);
            }
        }

        if (httpResponse.statusCode !== 206 && requestParams.start !== 0) {
             httpResponse.resume();
             return completionCallback(new Error("Server did not return partial content (status " + httpResponse.statusCode + ") for requested range starting at " + requestParams.start + " for url=" + sourceUrl));
        }

        if (receivedPosition !== null && receivedPosition !== requestParams.start) {
            httpResponse.resume();
            return completionCallback(new Error("Server returned incorrect range position. Expected " + requestParams.start + ", got " + receivedPosition + " for url=" + sourceUrl));
        }
    }
    completionCallback(null, httpResponse);
  });

  httpRequest.on('error', function(requestError) {
    completionCallback(new Error("HTTP request error: " + requestError.message + " for url=" + sourceUrl));
  });
};

MkvHttpReader.prototype._end = function(sessionContext, completionCallback) {
  setImmediate(completionCallback);
};

MkvHttpReader.prototype.toString = function() {
  return "[HttpSource url=" + this.targetUrl + "]";
};

var PARSER_STATE = {
  TAG: 1,
  SIZE: 2,
  CONTENT: 3,
  SKIP: 4
};

function MatroskaDecoder(configOptions) {
  streamModule.Writable.call(this, configOptions);
  
  configOptions = configOptions || {};
  this.configOptions = configOptions;
  
  this.skipTags = configOptions.skipTags;
  if (this.skipTags === undefined) {
    this.skipTags = {
      SimpleBlock: true,
      Void: true,
      Block: true,
      FileData: true,
      TagBinary: true
    };
  }
  
  this._streamSession = {};
  this.ignoreData = configOptions.ignoreData;
  this._buffer = null;
  this._tag_stack = [];
  this._state = PARSER_STATE.TAG;
  this._bufferOffset = 0;
  this._fileOffset = 0;
  this._tagVint = {};
  this._workingBuffer = new Buffer(64);
  this.document = new DocumentClass();
  this._skipTagData = (this.ignoreData === true);

  var decoderInstance = this;
  this.on('finish', function() {
    decoderInstance.document._buildLinks();
    decoderInstance.emit("$document", decoderInstance.document);
  });
}

nodeUtil.inherits(MatroskaDecoder, streamModule.Writable);

MatroskaDecoder.OnlyMetaDatas = function createMetadataConfig() {
  return {
    skipTags: {
      SimpleBlock: true,
      Void: true,
      Block: true,
      FileData: true,
      Cluster: true,
      Cues: true,
      Tracks: true
    }
  };
};

MatroskaDecoder.AllDatas = function createCompleteConfig() {
  return {
    skipTags: {}
  };
};

MatroskaDecoder.prototype._getStream = function(sourceObject, completionCallback) {
  var decoderInstance = this;
  var processingActive = true;

  sourceObject.getStream(this._streamSession, {
    start: decoderInstance._readOffset
  }, function handleStream(error, dataStream) {
    if (error) {
      return completionCallback(error);
    }
    decoderInstance._fileOffset = decoderInstance._readOffset;
    decoderInstance._buffer = null;
    decoderInstance._bufferOffset = 0;
    decoderInstance._skipBytes = 0;

    dataStream.on('end', function() {
      if (!processingActive) {
        return;
      }
      
      processingActive = false;
      completionCallback(null, decoderInstance.document);
    });

    dataStream.on('error', function(streamError) {
      if (!processingActive) {
        return;
      }
      completionCallback(streamError);
    });

    dataStream.on('readable', function() {
      if (!processingActive) {
        return;
      }
      var dataChunks = [];
      for (;;) {
        var chunk = dataStream.read();
        if (!chunk) {
          break;
        }
        dataChunks.push(chunk);
      }
      if (!dataChunks.length) {
        return;
      }
      var combinedBuffer = (dataChunks.length > 1) 
        ? Buffer.concat(dataChunks) 
        : dataChunks[0];
      
      var bytesRead = combinedBuffer.length;

      if (decoderInstance._skipBytes) {
        if (bytesRead <= decoderInstance._skipBytes) {
          decoderInstance._skipBytes -= bytesRead;
          decoderInstance._fileOffset += bytesRead;
          return;
        }
        combinedBuffer = combinedBuffer.slice(decoderInstance._skipBytes);
        bytesRead = combinedBuffer.length;
        decoderInstance._fileOffset += decoderInstance._skipBytes;
        decoderInstance._skipBytes = 0;
      }

      decoderInstance._readOffset += bytesRead;
      var positionBeforeProcessing = decoderInstance._readOffset;

      decoderInstance._write(combinedBuffer, null, function() {
        if (decoderInstance._stop) {
          processingActive = false;
          completionCallback(decoderInstance._parsingError, decoderInstance.document);
          return;
        }
        if (decoderInstance._skipBytes) {
          if (decoderInstance._buffer) {
            var remainingBytes = decoderInstance._buffer.length - decoderInstance._bufferOffset;
            if (decoderInstance._skipBytes <= remainingBytes) {
              decoderInstance._bufferOffset += decoderInstance._skipBytes;
              decoderInstance._fileOffset += decoderInstance._skipBytes;
              decoderInstance._skipBytes = 0;
              return;
            }
            decoderInstance._skipBytes -= remainingBytes;
            decoderInstance._fileOffset += remainingBytes;
            decoderInstance._buffer = null;
            decoderInstance._bufferOffset = 0;
          }
          if (decoderInstance._skipBytes >= 32000) {
            decoderInstance._readOffset += decoderInstance._skipBytes;
          }
        }
        if (positionBeforeProcessing !== decoderInstance._readOffset) {
          processingActive = false;
          dataStream.destroy();
          setImmediate(function() {
            decoderInstance._getStream(sourceObject, completionCallback);
          });
        }
      });
    });
  });
};

MatroskaDecoder.prototype.parse = function(dataSource, completionCallback) {
  if (this.document.children) {
    return completionCallback(new Error("Document already has children"));
  }
  if (typeof dataSource === "string") {
    if (/^http(s?):\/\//.test(dataSource)) {
      dataSource = new MkvHttpReader(dataSource);
    } else {
      throw new Error("File source not supported (" + dataSource + ")");
    }
  }
  if (!(dataSource instanceof MatroskaDataSource)) {
    throw new Error("Invalid source parameter (" + dataSource + ")");
  }
  this.document.source = dataSource;
  this._skipTagData = (this.ignoreData === true);
  this._readOffset = 0;
  
  var decoderInstance = this;

  this._getStream(dataSource, function(error, document) {
    dataSource.end(decoderInstance._streamSession, function() {
      if (document) {
        document._buildLinks();
      }
      completionCallback(error, document);
    });
  });
};

MatroskaDecoder.prototype._write = function(dataChunk, encoding, callback) {
  if (this._state === PARSER_STATE.SKIP) {
    if (this._skipBytes >= dataChunk.length) {
      this._skipBytes -= dataChunk.length;
      this._fileOffset += dataChunk.length;
      this._bufferOffset = 0;
      dataChunk = null;
    } else {
      this._fileOffset += this._skipBytes;
      this._bufferOffset = this._skipBytes;
      this._skipBytes = 0;
    }

    if (!this._skipBytes) {
      if (this._skipEndFunc) {
        this._skipEndFunc();
        this._skipEndFunc = null;
      }
      this._state = PARSER_STATE.TAG;
    }

    if (!dataChunk || !dataChunk.length) {
      callback();
      return;
    }

    this._buffer = null;
  }

  if (!this._buffer) {
    this._buffer = dataChunk;
  } else {
    var existingBuffer = this._buffer;
    if (this._bufferOffset) {
      existingBuffer = existingBuffer.slice(this._bufferOffset);
    }
    this._buffer = Buffer.concat([existingBuffer, dataChunk]);
  }

  this._bufferOffset = 0;

  try {
    while (!this._stop && this._buffer && this._bufferOffset < this._buffer.length) {
      if (this._state === PARSER_STATE.TAG) {
        if (!this.readTag()) {
          break;
        }
        continue;
      }
      
      if (this._state === PARSER_STATE.SIZE) {
        if (!this.readSize()) {
          break;
        }
        continue;
      }
      
      if (this._state === PARSER_STATE.CONTENT) {
        if (!this.readContent()) {
          break;
        }
        continue;
      }
      
      if (this._state === PARSER_STATE.SKIP) {
        break;
      }
    }
  } catch (parsingError) {
    this._parsingError = parsingError;
    this._stop = true;
    callback();
    return;
  }

  if (this._buffer && this._bufferOffset === this._buffer.length) {
    this._buffer = null;
    this._bufferOffset = 0;
  }

  callback();
};

MatroskaDecoder.prototype.readTag = function() {
  var startPosition = this._fileOffset;
  var tagHeader;
  
  try {
    tagHeader = utils.readHInt(this._buffer, this._bufferOffset, this._tagVint);
  } catch (error) {
    throw error;
  }

  if (tagHeader === null) {
    if (!this._EBMLFormatVerified && this._buffer.length > 7) {
      this._parsingError = new Error("Invalid format for " + this.document);
      this._stop = true;
      return false;
    }
    return false;
  }

  if (!this._EBMLFormatVerified) {
    if (tagHeader.value !== modelDefinitions.byName.EBML) {
      this._parsingError = new Error("Invalid format for " + this.document);
      this._stop = true;
      return false;
    }
    this._EBMLFormatVerified = true;
  }

  this._bufferOffset += tagHeader.length;
  this._fileOffset += tagHeader.length;
  this._state = PARSER_STATE.SIZE;

  var elementStack = this._tag_stack;
  var parentElement = elementStack.length ? elementStack[elementStack.length - 1] : null;
  var tagElement = this.document.createElement(tagHeader.value, startPosition, tagHeader.length);

  (parentElement || this.document).appendChild(tagElement, false);

  elementStack.push(tagElement);
  
  return true;
};

MatroskaDecoder.prototype.readSize = function() {
  var elementStack = this._tag_stack;
  var currentTag = elementStack[elementStack.length - 1];
  var sizeField = utils.readVInt(this._buffer, this._bufferOffset, this._tagVint);

  if (sizeField === null) {
    return false;
  }

  if (sizeField.value < 0) {
    throw new Error("Invalid size " + sizeField.value + " cursor=" + this._bufferOffset + " buffer=" + this._buffer.length);
  }

  this._bufferOffset += sizeField.length;
  this._fileOffset += sizeField.length;
  this._state = PARSER_STATE.CONTENT;

  currentTag._setDataSize(sizeField.value, sizeField.length);

  if (sizeField.value === 0) {
    return this.endContent(currentTag);
  }
  
  return true;
};

MatroskaDecoder.prototype.readContent = function() {
  var elementStack = this._tag_stack;
  var currentTag = elementStack[elementStack.length - 1];

  if (currentTag.masterType) {
    this.emit(currentTag._name, currentTag);
    this._state = PARSER_STATE.TAG;
    if (this.skipTags && this.skipTags[currentTag._name]) {
      elementStack.pop();

      var remainingInBuffer = this._buffer.length - this._bufferOffset;
      var contentSize = currentTag.end - this._fileOffset;

      if (contentSize >= remainingInBuffer) {
        this._skipBytes = contentSize - remainingInBuffer;
        this._fileOffset += remainingInBuffer;
        this._buffer = null;
        this._bufferOffset = 0;
        this._state = PARSER_STATE.SKIP;
        return false;
      }

      this._bufferOffset += contentSize;
      this._fileOffset += contentSize;
      
      return true;
    }
    
    return true;
  }

  var remainingInBuffer = this._buffer.length - this._bufferOffset;

  if (remainingInBuffer < currentTag.dataSize) {
    if (this._skipTagData || (this.skipTags && this.skipTags[currentTag._name])) {
      this._skipBytes = currentTag.dataSize - remainingInBuffer;
      this._fileOffset += remainingInBuffer;
      this._buffer = null;
      this._bufferOffset = 0;
      this._state = PARSER_STATE.SKIP;
      this._skipEndFunc = this.endContent.bind(this, currentTag);
    }
    
    return false;
  }

  if (!this.ignoreData && (!this.skipTags || !this.skipTags[currentTag._name])) {
    var tagData = this._buffer.slice(this._bufferOffset, this._bufferOffset + currentTag.dataSize);
    currentTag._setData(tagData);
  }

  this._fileOffset += currentTag.dataSize;
  this._buffer = this._buffer.slice(this._bufferOffset + currentTag.dataSize);
  this._bufferOffset = 0;
  
  return this.endContent(currentTag);
};

MatroskaDecoder.prototype.endContent = function(tagElement) {
  var elementStack = this._tag_stack;
  elementStack.pop();
  while (elementStack.length) {
    var topElement = elementStack[elementStack.length - 1];
    if (this._fileOffset < topElement.end) {
      break;
    }
    this.emit(topElement._name + ':end', topElement);
    elementStack.pop();
  }
  this.emit(tagElement._name, tagElement);
  this._state = PARSER_STATE.TAG;
  return true;
};

MatroskaDecoder.prototype.parseEbmlIDs = function(dataSource, ebmlIDList, completionCallback) {
  if (!nodeUtil.isArray(ebmlIDList)) {
    ebmlIDList = [ebmlIDList];
  }
  this.document._partial = true;
  var decoderInstance = this;
  var segmentContentPosition;
  var idsToFind = {};
  var foundElements = {};
  var positionsList = [];
  function processNextPosition() {
    if (!positionsList.length) {
      decoderInstance._stop = true;
      return;
    }
    var nextOffset = positionsList.shift();
    var absoluteOffset = segmentContentPosition + nextOffset;
    if (decoderInstance._buffer) {
      var bufferStart = decoderInstance._fileOffset - decoderInstance._bufferOffset;
      if (absoluteOffset >= bufferStart && 
          absoluteOffset < bufferStart + decoderInstance._buffer.length) {
        decoderInstance._fileOffset = absoluteOffset;
        decoderInstance._bufferOffset = absoluteOffset - bufferStart;
        decoderInstance._skipBytes = 0;
        decoderInstance._state = PARSER_STATE.TAG;
        return;
      }
    }

    if (absoluteOffset > decoderInstance._readOffset) {
      decoderInstance._skipBytes = absoluteOffset - decoderInstance._readOffset;
      decoderInstance._fileOffset = decoderInstance._readOffset;
      decoderInstance._buffer = null;
      decoderInstance._bufferOffset = 0;
      decoderInstance._state = PARSER_STATE.TAG;
      return;
    }

    decoderInstance._readOffset = absoluteOffset;
    decoderInstance._fileOffset = absoluteOffset;
    decoderInstance._buffer = null;
    decoderInstance._bufferOffset = 0;
    decoderInstance._skipBytes = 0;
    decoderInstance._state = PARSER_STATE.TAG;
  }

  ebmlIDList.forEach(function(idName) {
    var numericID = utils.convertEbmlID(idName);

    if (idsToFind[numericID]) {
      return;
    }

    idsToFind[numericID] = true;

    var elementName = modelDefinitions.byEbmlID[numericID].name;

    decoderInstance.on(elementName, function(element) {
      foundElements[element.ebmlID] = element;
    });

    decoderInstance.on(elementName + ":end", function() {
      processNextPosition();
    });
  });

  decoderInstance.on("Seek:end", function(seekElement) {
    var targetID = seekElement.seekID;
    if (!idsToFind[targetID]) {
      return;
    }
    positionsList.push(seekElement.seekPosition);
  });

  decoderInstance.on("SeekHead:end", function(seekHeadElement) {
    segmentContentPosition = seekHeadElement.getLevel1().getContentPosition();

    positionsList.sort(function(a, b) {
      return a - b;
    });

    processNextPosition();
  });

  this.parse(dataSource, function(error, document) {
    if (error) {
      return completionCallback(error);
    }
    
    completionCallback(null, decoderInstance.document, foundElements);
  });
};

MatroskaDecoder.parseInfoTagsAndAttachments = function(dataSource, completionCallback) {
  var decoder = new MatroskaDecoder(MatroskaDecoder.OnlyMetaDatas());
  decoder.parseEbmlIDs(
    dataSource, 
    [
      modelDefinitions.byName.Info, 
      modelDefinitions.byName.Tags, 
      modelDefinitions.byName.Attachments
    ], 
    completionCallback
  );
};

module.exports = MatroskaDecoder;
