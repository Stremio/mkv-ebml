var modelDefinitions = require('./model');
var dateFormatter = require('dateformat');

var SIZE_CLASS = {
  A: Math.pow(2, 7),  
  B: Math.pow(2, 14), 
  C: Math.pow(2, 21), 
  D: Math.pow(2, 28), 
  E: Math.pow(2, 35), 
  F: Math.pow(2, 42), 
  G: Math.pow(2, 49), 
  H: Math.pow(2, 56)  
};

var MAX_BITS = {
  UINT7: Math.pow(2, 7),   
  UINT8: Math.pow(2, 8),   
  UINT15: Math.pow(2, 15), 
  UINT16: Math.pow(2, 16), 
  UINT23: Math.pow(2, 23), 
  UINT24: Math.pow(2, 24), 
  UINT31: Math.pow(2, 31), 
  UINT32: Math.pow(2, 32), 
  UINT39: Math.pow(2, 39), 
  UINT40: Math.pow(2, 40), 
  UINT47: Math.pow(2, 47), 
  UINT48: Math.pow(2, 48), 
  UINT52: Math.pow(2, 52), 
  UINT53: Math.pow(2, 53), 
  UINT55: Math.pow(2, 55), 
  UINT56: Math.pow(2, 56)  
};

var BYTE_POSITION_VALUES = [
  0,                  
  256,                
  Math.pow(2, 16),    
  Math.pow(2, 24),    
  Math.pow(2, 32),    
  Math.pow(2, 40),    
  Math.pow(2, 48),    
  Math.pow(2, 56)     
];

var SMALL_BUFFERS = {
  INT: [new Buffer([0]), new Buffer([1]), new Buffer([2]), new Buffer([3])],
  VINT: [new Buffer([0x80]), new Buffer([0x81])]
};

var FLOAT_CONVERSION_BUFFER = new Buffer(4);

var MatroskaTools = {
    readVInt: function decodeVariableLengthInteger(dataBuffer, startOffset, resultObject, preserveMask) {
    startOffset = startOffset || 0;
    
    var firstByte = dataBuffer[startOffset];
    if (!firstByte) {
      var error = new Error("INVALID VINT format (value=0)");
      error.code = 'INVALID';
      throw error;
    }
    
    var byteLength = 8; 
    
    if (firstByte >= 0x80) {
      byteLength = 1;
    } else if (firstByte >= 0x40) {
      byteLength = 2;
    } else if (firstByte >= 0x20) {
      byteLength = 3;
    } else if (firstByte >= 0x10) {
      byteLength = 4;
    } else if (firstByte >= 0x08) {
      byteLength = 5;
    } else if (firstByte >= 0x04) {
      byteLength = 6;
    } else if (firstByte >= 0x02) {
      byteLength = 7;
    } else if (firstByte >= 0x01) {
      byteLength = 8;
    } else {
      var error = new Error("INVALID VINT format (length>7 bs=" + firstByte + ")");
      error.code = 'INVALID';
      throw error;
    }
    
    if (startOffset + byteLength > dataBuffer.length) {
      return null;
    }
    
    if (!resultObject) {
      resultObject = {};
    }
    
    resultObject.length = byteLength;
    
    var integerValue = firstByte;
    if (!preserveMask) {
      
      integerValue &= ((1 << (8 - byteLength)) - 1);
    }
    
    byteLength--;
    startOffset++;
    
    while (byteLength > 0) {
      var bytesToRead = Math.min(byteLength, 6);
      
      var chunkValue = dataBuffer.readUIntBE(startOffset, bytesToRead);
      integerValue = integerValue * BYTE_POSITION_VALUES[bytesToRead] + chunkValue;
      
      if (byteLength === 7) {
        if (integerValue >= MAX_BITS.UINT40) {
          var error = new Error("INVALID VINT value too big (length>7 bs=" + firstByte + ")");
          error.code = 'INVALID';
          throw error;
        }
      }

      byteLength -= bytesToRead;
      startOffset += bytesToRead;
    }

    resultObject.value = integerValue;
    return resultObject;
  },
  writeVInt: function encodeVariableLengthInteger(intValue, targetBuffer, targetOffset) {
    if (intValue < 0) {
      throw new Error("Cannot encode negative value: " + intValue);
    }
    
    if (intValue < SMALL_BUFFERS.VINT.length) {
      return SMALL_BUFFERS.VINT[intValue];
    }
    
    var encodedLength = this.sizeVInt(intValue);
    
    if (!targetBuffer) {
      targetBuffer = new Buffer(encodedLength);
      targetOffset = 0;
    }
    
    this.writeVIntBuffer(intValue, targetBuffer, targetOffset);
    
    if (targetOffset === 0 && targetBuffer.length === encodedLength) {
      return targetBuffer;
    }
    
    return targetBuffer.slice(targetOffset, targetOffset + encodedLength);
  },
  
  writeVIntBuffer: function writeVariableLengthIntegerToBuffer(intValue, targetBuffer, targetOffset) {
    
    if (intValue < 0) {
      throw new Error("Cannot encode negative value: " + intValue);
    }

    if (targetOffset < 0 || isNaN(targetOffset)) {
      throw new Error("Invalid offset: " + targetOffset);
    }
    
    var encodedLength = this.sizeVInt(intValue);
    
    if (encodedLength > 1) {
      var remainingLength = encodedLength - 1;
      var writeOffset = targetOffset + remainingLength + 1;
      
      while (remainingLength > 0) {
        var bytesToWrite = Math.min(remainingLength, 6);
        writeOffset -= bytesToWrite;
        targetBuffer.writeUIntBE(intValue, writeOffset, bytesToWrite, true);
        intValue /= BYTE_POSITION_VALUES[bytesToWrite];
        remainingLength -= bytesToWrite;
      }
    }

    targetBuffer[targetOffset] = intValue | (1 << (8 - encodedLength));

    return encodedLength;
  },
  readHInt: function readHeaderInteger(dataBuffer, startOffset, resultObject) {
    return this.readVInt(dataBuffer, startOffset, resultObject, true);
  },
  
  sizeHInt: function calculateHeaderIntegerSize(intValue) {
    if (intValue < 0) {
      throw new Error("Cannot encode negative value: " + intValue);
    }

    return this.sizeVInt(intValue / 2);
  },
  sizeVInt: function calculateVariableIntegerSize(intValue) {
    if (intValue < 0) {
      throw new Error("Cannot encode negative value: " + intValue);
    }
    
    if (intValue < SIZE_CLASS.A - 1) {
      return 1;
    }
    if (intValue < SIZE_CLASS.B - 1) {
      return 2;
    }
    if (intValue < SIZE_CLASS.C - 1) {
      return 3;
    }
    if (intValue < SIZE_CLASS.D - 1) {
      return 4;
    }
    if (intValue < SIZE_CLASS.E - 1) {
      return 5;
    }
    if (intValue < SIZE_CLASS.F - 1) {
      return 6;
    }
    if (intValue < SIZE_CLASS.G - 1) {
      return 7;
    }
    
    return 8;
  },
  sizeUInt: function calculateUnsignedIntegerSize(intValue) {
    if (intValue < 0) {
      throw new Error("Cannot encode negative value: " + intValue);
    }

    if (intValue < MAX_BITS.UINT8) {
      return 1;
    }
    if (intValue < MAX_BITS.UINT16) {
      return 2;
    }
    if (intValue < MAX_BITS.UINT24) {
      return 3;
    }
    if (intValue < MAX_BITS.UINT32) {
      return 4;
    }
    if (intValue < MAX_BITS.UINT40) {
      return 5;
    }
    if (intValue < MAX_BITS.UINT48) {
      return 6;
    }
    if (intValue < MAX_BITS.UINT56) {
      return 7;
    }
    
    return 8;
  },
  sizeInt: function calculateSignedIntegerSize(intValue) {
    if (intValue > -MAX_BITS.UINT7 && intValue < MAX_BITS.UINT7) {
      return 1;
    }
    if (intValue > -MAX_BITS.UINT15 && intValue < MAX_BITS.UINT15) {
      return 2;
    }
    if (intValue > -MAX_BITS.UINT23 && intValue < MAX_BITS.UINT23) {
      return 3;
    }
    if (intValue > -MAX_BITS.UINT31 && intValue < MAX_BITS.UINT31) {
      return 4;
    }
    if (intValue > -MAX_BITS.UINT39 && intValue < MAX_BITS.UINT39) {
      return 5;
    }
    if (intValue > -MAX_BITS.UINT47 && intValue < MAX_BITS.UINT47) {
      return 6;
    }
    if (intValue > -MAX_BITS.UINT55 && intValue < MAX_BITS.UINT55) {
      return 7;
    }
    return 8;
  },
  sizeFloat: function calculateFloatSize(floatValue) {
    FLOAT_CONVERSION_BUFFER.writeFloatBE(floatValue, 0);
    var roundTripValue = FLOAT_CONVERSION_BUFFER.readFloatBE(0);

    if (roundTripValue !== floatValue) {
      return 8;
    }
    
    return 4;
  },
  writeInt: function encodeSignedInteger(intValue) {
    var encodedSize = this.sizeInt(intValue);
    var resultBuffer;

    if (encodedSize === 1) {
      if (intValue >= 0 && intValue < SMALL_BUFFERS.INT.length) {
        return SMALL_BUFFERS.INT[intValue];
      }
      
      resultBuffer = new Buffer(1);
      resultBuffer[0] = intValue;
      return resultBuffer;
    }

    if (encodedSize < 7) {
      resultBuffer = new Buffer(encodedSize);
      resultBuffer.writeIntBE(0, intValue, resultBuffer.length);
      return resultBuffer;
    }

    if (intValue > -MAX_BITS.UINT53 && intValue < MAX_BITS.UINT53) {
      resultBuffer = new Buffer(7);
      resultBuffer[0] = intValue / MAX_BITS.UINT48;
      resultBuffer.writeUIntBE(intValue, 1, 6, true);
      return resultBuffer;
    }
    
    throw new Error("Cannot encode integer larger than 52 bits");
  },
  writeUInt: function encodeUnsignedInteger(intValue) {
    var encodedSize = this.sizeUInt(intValue);
    var resultBuffer;

    if (encodedSize === 1) {
      if (intValue < SMALL_BUFFERS.INT.length) {
        return SMALL_BUFFERS.INT[intValue];
      }

      resultBuffer = new Buffer(1);
      resultBuffer[0] = intValue;
      return resultBuffer;
    }

    if (encodedSize < 7) {
      try {
        resultBuffer = new Buffer(encodedSize);
        resultBuffer.writeUIntBE(intValue, 0, resultBuffer.length);
      } catch (error) {
        throw new Error("Failed to encode value: " + intValue + 
                        ", length: " + resultBuffer.length + 
                        ", error: " + error);
      }
      return resultBuffer;
    }

    if (intValue < MAX_BITS.UINT53) {
      resultBuffer = new Buffer(7);
      resultBuffer[0] = intValue / MAX_BITS.UINT48;
      resultBuffer.writeUIntBE(intValue, 1, 6, true);
      return resultBuffer;
    }
    
    throw new Error("Cannot encode integer larger than 52 bits");
  },
  convertEbmlID: function resolveEbmlIDFromName(ebmlID) {
    if (typeof ebmlID === "number") {
      return ebmlID;
    }

    if (typeof ebmlID === "string") {
      var modelElement = modelDefinitions.byName[ebmlID];
      if (!modelElement) {
        throw new Error("Unknown EBML ID name: " + ebmlID);
      }

      return modelElement;
    }

    throw new Error("Invalid EBML ID parameter: " + ebmlID);
  },
  writeCRC: function encodeCRCValue(crcValue) {
    var resultBuffer = new Buffer(4);
    
    for (var i = 0; i < 4; i++) {
      resultBuffer[i] = crcValue;
      crcValue >>= 8;
    }
    
    return resultBuffer;
  },
  writeEbmlID: function encodeEbmlID(ebmlID) {
    var tempBuffer = new Buffer(8);

    for (var i = tempBuffer.length - 1; i >= 0; i--) {
      tempBuffer[i] = ebmlID;
      ebmlID >>= 8;

      if (!ebmlID) {
        return tempBuffer.slice(i);
      }
    }
    
    return tempBuffer;
  },
  readCRC: function decodeCRCValue(dataBuffer) {
    var bufferLength = dataBuffer.length;
    var crcValue = 0;

    for (var i = 0; i < bufferLength; i++) {
      crcValue = (crcValue << 8) + dataBuffer[i];
    }
    
    return crcValue;
  },
  formatDate: function formatDateWithTime(dateValue) {
    return dateFormatter(dateValue, "yyyy-mm-dd HH:MM:ss.l");
  },
  formatDay: function formatDateDayOnly(dateValue) {
    return dateFormatter(dateValue, "yyyy-mm-dd");
  },
  formatYear: function formatDateYearOnly(dateValue) {
    return dateFormatter(dateValue, "yyyy");
  },
  validType: function validateValueForType(typeCode, value) {
    switch (typeCode) {
      case "8":
      case "s":
        if (typeof value === "string" || value === null || value === undefined) {
          return value;
        }
        break;
      case "u":
      case "i":
        if (typeof value === "number" || value === undefined) {
          return value;
        }
        break;
      case "f":
        if (typeof value === "number" || value === undefined) {
          return value;
        }
        break;
      case "d":
        if (value instanceof Date || value === null || value === undefined) {
          return value;
        }
        break;
      case "b":
        if (Buffer.isBuffer(value) || value === null || value === undefined) {
          return value;
        }
        break;
    }
    throw new Error("Invalid value '" + value + "' for type '" + typeCode + "'");
  }
};

module.exports = MatroskaTools;
