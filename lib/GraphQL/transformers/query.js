"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.transformQueryInputToParse = exports.transformQueryConstraintInputToParse = void 0;

function ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); keys.push.apply(keys, symbols); } return keys; }

function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { ownKeys(source, true).forEach(function (key) { _defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { ownKeys(source).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

const parseQueryMap = {
  id: 'objectId',
  OR: '$or',
  AND: '$and',
  NOR: '$nor'
};
const parseConstraintMap = {
  equalTo: '$eq',
  notEqualTo: '$ne',
  lessThan: '$lt',
  lessThanOrEqualTo: '$lte',
  greaterThan: '$gt',
  greaterThanOrEqualTo: '$gte',
  in: '$in',
  notIn: '$nin',
  exists: '$exists',
  inQueryKey: '$select',
  notInQueryKey: '$dontSelect',
  inQuery: '$inQuery',
  notInQuery: '$notInQuery',
  containedBy: '$containedBy',
  contains: '$all',
  matchesRegex: '$regex',
  options: '$options',
  text: '$text',
  search: '$search',
  term: '$term',
  language: '$language',
  caseSensitive: '$caseSensitive',
  diacriticSensitive: '$diacriticSensitive',
  nearSphere: '$nearSphere',
  maxDistance: '$maxDistance',
  maxDistanceInRadians: '$maxDistanceInRadians',
  maxDistanceInMiles: '$maxDistanceInMiles',
  maxDistanceInKilometers: '$maxDistanceInKilometers',
  within: '$within',
  box: '$box',
  geoWithin: '$geoWithin',
  polygon: '$polygon',
  centerSphere: '$centerSphere',
  geoIntersects: '$geoIntersects',
  point: '$point'
};

const transformQueryConstraintInputToParse = (constraints, fields, parentFieldName, parentConstraints) => {
  Object.keys(constraints).forEach(fieldName => {
    let fieldValue = constraints[fieldName];
    /**
     * If we have a key-value pair, we need to change the way the constraint is structured.
     *
     * Example:
     *   From:
     *   {
     *     "someField": {
     *       "lessThan": {
     *         "key":"foo.bar",
     *         "value": 100
     *       },
     *       "greaterThan": {
     *         "key":"foo.bar",
     *         "value": 10
     *       }
     *     }
     *   }
     *
     *   To:
     *   {
     *     "someField.foo.bar": {
     *       "$lt": 100,
     *       "$gt": 10
     *      }
     *   }
     */

    if (fieldValue.key && fieldValue.value && parentConstraints && parentFieldName) {
      delete parentConstraints[parentFieldName];
      parentConstraints[`${parentFieldName}.${fieldValue.key}`] = _objectSpread({}, parentConstraints[`${parentFieldName}.${fieldValue.key}`], {
        [parseConstraintMap[fieldName]]: fieldValue.value
      });
    } else if (parseConstraintMap[fieldName]) {
      delete constraints[fieldName];
      fieldName = parseConstraintMap[fieldName];
      constraints[fieldName] = fieldValue; // If parent field type is Pointer, changes constraint value to format expected
      // by Parse.

      if (fields[parentFieldName] && fields[parentFieldName].type === 'Pointer' && typeof fieldValue === 'string') {
        const {
          targetClass
        } = fields[parentFieldName];
        constraints[fieldName] = {
          __type: 'Pointer',
          className: targetClass,
          objectId: fieldValue
        };
      }
    }

    switch (fieldName) {
      case '$point':
      case '$nearSphere':
        if (typeof fieldValue === 'object' && !fieldValue.__type) {
          fieldValue.__type = 'GeoPoint';
        }

        break;

      case '$box':
        if (typeof fieldValue === 'object' && fieldValue.bottomLeft && fieldValue.upperRight) {
          fieldValue = [_objectSpread({
            __type: 'GeoPoint'
          }, fieldValue.bottomLeft), _objectSpread({
            __type: 'GeoPoint'
          }, fieldValue.upperRight)];
          constraints[fieldName] = fieldValue;
        }

        break;

      case '$polygon':
        if (fieldValue instanceof Array) {
          fieldValue.forEach(geoPoint => {
            if (typeof geoPoint === 'object' && !geoPoint.__type) {
              geoPoint.__type = 'GeoPoint';
            }
          });
        }

        break;

      case '$centerSphere':
        if (typeof fieldValue === 'object' && fieldValue.center && fieldValue.distance) {
          fieldValue = [_objectSpread({
            __type: 'GeoPoint'
          }, fieldValue.center), fieldValue.distance];
          constraints[fieldName] = fieldValue;
        }

        break;
    }

    if (typeof fieldValue === 'object') {
      if (fieldName === 'where') {
        transformQueryInputToParse(fieldValue);
      } else {
        transformQueryConstraintInputToParse(fieldValue, fields, fieldName, constraints);
      }
    }
  });
};

exports.transformQueryConstraintInputToParse = transformQueryConstraintInputToParse;

const transformQueryInputToParse = (constraints, fields) => {
  if (!constraints || typeof constraints !== 'object') {
    return;
  }

  Object.keys(constraints).forEach(fieldName => {
    const fieldValue = constraints[fieldName];

    if (parseQueryMap[fieldName]) {
      delete constraints[fieldName];
      fieldName = parseQueryMap[fieldName];
      constraints[fieldName] = fieldValue;

      if (fieldName !== 'objectId') {
        fieldValue.forEach(fieldValueItem => {
          transformQueryInputToParse(fieldValueItem, fields);
        });
        return;
      }
    }

    if (typeof fieldValue === 'object') {
      transformQueryConstraintInputToParse(fieldValue, fields, fieldName, constraints);
    }
  });
};

exports.transformQueryInputToParse = transformQueryInputToParse;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9HcmFwaFFML3RyYW5zZm9ybWVycy9xdWVyeS5qcyJdLCJuYW1lcyI6WyJwYXJzZVF1ZXJ5TWFwIiwiaWQiLCJPUiIsIkFORCIsIk5PUiIsInBhcnNlQ29uc3RyYWludE1hcCIsImVxdWFsVG8iLCJub3RFcXVhbFRvIiwibGVzc1RoYW4iLCJsZXNzVGhhbk9yRXF1YWxUbyIsImdyZWF0ZXJUaGFuIiwiZ3JlYXRlclRoYW5PckVxdWFsVG8iLCJpbiIsIm5vdEluIiwiZXhpc3RzIiwiaW5RdWVyeUtleSIsIm5vdEluUXVlcnlLZXkiLCJpblF1ZXJ5Iiwibm90SW5RdWVyeSIsImNvbnRhaW5lZEJ5IiwiY29udGFpbnMiLCJtYXRjaGVzUmVnZXgiLCJvcHRpb25zIiwidGV4dCIsInNlYXJjaCIsInRlcm0iLCJsYW5ndWFnZSIsImNhc2VTZW5zaXRpdmUiLCJkaWFjcml0aWNTZW5zaXRpdmUiLCJuZWFyU3BoZXJlIiwibWF4RGlzdGFuY2UiLCJtYXhEaXN0YW5jZUluUmFkaWFucyIsIm1heERpc3RhbmNlSW5NaWxlcyIsIm1heERpc3RhbmNlSW5LaWxvbWV0ZXJzIiwid2l0aGluIiwiYm94IiwiZ2VvV2l0aGluIiwicG9seWdvbiIsImNlbnRlclNwaGVyZSIsImdlb0ludGVyc2VjdHMiLCJwb2ludCIsInRyYW5zZm9ybVF1ZXJ5Q29uc3RyYWludElucHV0VG9QYXJzZSIsImNvbnN0cmFpbnRzIiwiZmllbGRzIiwicGFyZW50RmllbGROYW1lIiwicGFyZW50Q29uc3RyYWludHMiLCJPYmplY3QiLCJrZXlzIiwiZm9yRWFjaCIsImZpZWxkTmFtZSIsImZpZWxkVmFsdWUiLCJrZXkiLCJ2YWx1ZSIsInR5cGUiLCJ0YXJnZXRDbGFzcyIsIl9fdHlwZSIsImNsYXNzTmFtZSIsIm9iamVjdElkIiwiYm90dG9tTGVmdCIsInVwcGVyUmlnaHQiLCJBcnJheSIsImdlb1BvaW50IiwiY2VudGVyIiwiZGlzdGFuY2UiLCJ0cmFuc2Zvcm1RdWVyeUlucHV0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QUF1QixRQUEzQyxFQUFxRDtBQUNuRDtBQUNEOztBQUVESSxFQUFBQSxNQUFNLENBQUNDLElBQVAsQ0FBWUwsV0FBWixFQUF5Qk0sT0FBekIsQ0FBaUNDLFNBQVMsSUFBSTtBQUM1QyxVQUFNQyxVQUFVLEdBQUdSLFdBQVcsQ0FBQ08sU0FBRCxDQUE5Qjs7QUFFQSxRQUFJakQsYUFBYSxDQUFDaUQsU0FBRCxDQUFqQixFQUE4QjtBQUM1QixhQUFPUCxXQUFXLENBQUNPLFNBQUQsQ0FBbEI7QUFDQUEsTUFBQUEsU0FBUyxHQUFHakQsYUFBYSxDQUFDaUQsU0FBRCxDQUF6QjtBQUNBUCxNQUFBQSxXQUFXLENBQUNPLFNBQUQsQ0FBWCxHQUF5QkMsVUFBekI7O0FBRUEsVUFBSUQsU0FBUyxLQUFLLFVBQWxCLEVBQThCO0FBQzVCQyxRQUFBQSxVQUFVLENBQUNGLE9BQVgsQ0FBbUJpQixjQUFjLElBQUk7QUFDbkNELFVBQUFBLDBCQUEwQixDQUFDQyxjQUFELEVBQWlCdEIsTUFBakIsQ0FBMUI7QUFDRCxTQUZEO0FBR0E7QUFDRDtBQUNGOztBQUVELFFBQUksT0FBT08sVUFBUCxLQUFzQixRQUExQixFQUFvQztBQUNsQ1QsTUFBQUEsb0NBQW9DLENBQUNTLFVBQUQsRUFBYVAsTUFBYixFQUFxQk0sU0FBckIsRUFBZ0NQLFdBQWhDLENBQXBDO0FBQ0Q7QUFDRixHQW5CRDtBQW9CRCxDQXpCRCIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IHBhcnNlUXVlcnlNYXAgPSB7XG4gIGlkOiAnb2JqZWN0SWQnLFxuICBPUjogJyRvcicsXG4gIEFORDogJyRhbmQnLFxuICBOT1I6ICckbm9yJyxcbn07XG5cbmNvbnN0IHBhcnNlQ29uc3RyYWludE1hcCA9IHtcbiAgZXF1YWxUbzogJyRlcScsXG4gIG5vdEVxdWFsVG86ICckbmUnLFxuICBsZXNzVGhhbjogJyRsdCcsXG4gIGxlc3NUaGFuT3JFcXVhbFRvOiAnJGx0ZScsXG4gIGdyZWF0ZXJUaGFuOiAnJGd0JyxcbiAgZ3JlYXRlclRoYW5PckVxdWFsVG86ICckZ3RlJyxcbiAgaW46ICckaW4nLFxuICBub3RJbjogJyRuaW4nLFxuICBleGlzdHM6ICckZXhpc3RzJyxcbiAgaW5RdWVyeUtleTogJyRzZWxlY3QnLFxuICBub3RJblF1ZXJ5S2V5OiAnJGRvbnRTZWxlY3QnLFxuICBpblF1ZXJ5OiAnJGluUXVlcnknLFxuICBub3RJblF1ZXJ5OiAnJG5vdEluUXVlcnknLFxuICBjb250YWluZWRCeTogJyRjb250YWluZWRCeScsXG4gIGNvbnRhaW5zOiAnJGFsbCcsXG4gIG1hdGNoZXNSZWdleDogJyRyZWdleCcsXG4gIG9wdGlvbnM6ICckb3B0aW9ucycsXG4gIHRleHQ6ICckdGV4dCcsXG4gIHNlYXJjaDogJyRzZWFyY2gnLFxuICB0ZXJtOiAnJHRlcm0nLFxuICBsYW5ndWFnZTogJyRsYW5ndWFnZScsXG4gIGNhc2VTZW5zaXRpdmU6ICckY2FzZVNlbnNpdGl2ZScsXG4gIGRpYWNyaXRpY1NlbnNpdGl2ZTogJyRkaWFjcml0aWNTZW5zaXRpdmUnLFxuICBuZWFyU3BoZXJlOiAnJG5lYXJTcGhlcmUnLFxuICBtYXhEaXN0YW5jZTogJyRtYXhEaXN0YW5jZScsXG4gIG1heERpc3RhbmNlSW5SYWRpYW5zOiAnJG1heERpc3RhbmNlSW5SYWRpYW5zJyxcbiAgbWF4RGlzdGFuY2VJbk1pbGVzOiAnJG1heERpc3RhbmNlSW5NaWxlcycsXG4gIG1heERpc3RhbmNlSW5LaWxvbWV0ZXJzOiAnJG1heERpc3RhbmNlSW5LaWxvbWV0ZXJzJyxcbiAgd2l0aGluOiAnJHdpdGhpbicsXG4gIGJveDogJyRib3gnLFxuICBnZW9XaXRoaW46ICckZ2VvV2l0aGluJyxcbiAgcG9seWdvbjogJyRwb2x5Z29uJyxcbiAgY2VudGVyU3BoZXJlOiAnJGNlbnRlclNwaGVyZScsXG4gIGdlb0ludGVyc2VjdHM6ICckZ2VvSW50ZXJzZWN0cycsXG4gIHBvaW50OiAnJHBvaW50Jyxcbn07XG5cbmNvbnN0IHRyYW5zZm9ybVF1ZXJ5Q29uc3RyYWludElucHV0VG9QYXJzZSA9IChcbiAgY29uc3RyYWludHMsXG4gIGZpZWxkcyxcbiAgcGFyZW50RmllbGROYW1lLFxuICBwYXJlbnRDb25zdHJhaW50c1xuKSA9PiB7XG4gIE9iamVjdC5rZXlzKGNvbnN0cmFpbnRzKS5mb3JFYWNoKGZpZWxkTmFtZSA9PiB7XG4gICAgbGV0IGZpZWxkVmFsdWUgPSBjb25zdHJhaW50c1tmaWVsZE5hbWVdO1xuXG4gICAgLyoqXG4gICAgICogSWYgd2UgaGF2ZSBhIGtleS12YWx1ZSBwYWlyLCB3ZSBuZWVkIHRvIGNoYW5nZSB0aGUgd2F5IHRoZSBjb25zdHJhaW50IGlzIHN0cnVjdHVyZWQuXG4gICAgICpcbiAgICAgKiBFeGFtcGxlOlxuICAgICAqICAgRnJvbTpcbiAgICAgKiAgIHtcbiAgICAgKiAgICAgXCJzb21lRmllbGRcIjoge1xuICAgICAqICAgICAgIFwibGVzc1RoYW5cIjoge1xuICAgICAqICAgICAgICAgXCJrZXlcIjpcImZvby5iYXJcIixcbiAgICAgKiAgICAgICAgIFwidmFsdWVcIjogMTAwXG4gICAgICogICAgICAgfSxcbiAgICAgKiAgICAgICBcImdyZWF0ZXJUaGFuXCI6IHtcbiAgICAgKiAgICAgICAgIFwia2V5XCI6XCJmb28uYmFyXCIsXG4gICAgICogICAgICAgICBcInZhbHVlXCI6IDEwXG4gICAgICogICAgICAgfVxuICAgICAqICAgICB9XG4gICAgICogICB9XG4gICAgICpcbiAgICAgKiAgIFRvOlxuICAgICAqICAge1xuICAgICAqICAgICBcInNvbWVGaWVsZC5mb28uYmFyXCI6IHtcbiAgICAgKiAgICAgICBcIiRsdFwiOiAxMDAsXG4gICAgICogICAgICAgXCIkZ3RcIjogMTBcbiAgICAgKiAgICAgIH1cbiAgICAgKiAgIH1cbiAgICAgKi9cbiAgICBpZiAoXG4gICAgICBmaWVsZFZhbHVlLmtleSAmJlxuICAgICAgZmllbGRWYWx1ZS52YWx1ZSAmJlxuICAgICAgcGFyZW50Q29uc3RyYWludHMgJiZcbiAgICAgIHBhcmVudEZpZWxkTmFtZVxuICAgICkge1xuICAgICAgZGVsZXRlIHBhcmVudENvbnN0cmFpbnRzW3BhcmVudEZpZWxkTmFtZV07XG4gICAgICBwYXJlbnRDb25zdHJhaW50c1tgJHtwYXJlbnRGaWVsZE5hbWV9LiR7ZmllbGRWYWx1ZS5rZXl9YF0gPSB7XG4gICAgICAgIC4uLnBhcmVudENvbnN0cmFpbnRzW2Ake3BhcmVudEZpZWxkTmFtZX0uJHtmaWVsZFZhbHVlLmtleX1gXSxcbiAgICAgICAgW3BhcnNlQ29uc3RyYWludE1hcFtmaWVsZE5hbWVdXTogZmllbGRWYWx1ZS52YWx1ZSxcbiAgICAgIH07XG4gICAgfSBlbHNlIGlmIChwYXJzZUNvbnN0cmFpbnRNYXBbZmllbGROYW1lXSkge1xuICAgICAgZGVsZXRlIGNvbnN0cmFpbnRzW2ZpZWxkTmFtZV07XG4gICAgICBmaWVsZE5hbWUgPSBwYXJzZUNvbnN0cmFpbnRNYXBbZmllbGROYW1lXTtcbiAgICAgIGNvbnN0cmFpbnRzW2ZpZWxkTmFtZV0gPSBmaWVsZFZhbHVlO1xuXG4gICAgICAvLyBJZiBwYXJlbnQgZmllbGQgdHlwZSBpcyBQb2ludGVyLCBjaGFuZ2VzIGNvbnN0cmFpbnQgdmFsdWUgdG8gZm9ybWF0IGV4cGVjdGVkXG4gICAgICAvLyBieSBQYXJzZS5cbiAgICAgIGlmIChcbiAgICAgICAgZmllbGRzW3BhcmVudEZpZWxkTmFtZV0gJiZcbiAgICAgICAgZmllbGRzW3BhcmVudEZpZWxkTmFtZV0udHlwZSA9PT0gJ1BvaW50ZXInICYmXG4gICAgICAgIHR5cGVvZiBmaWVsZFZhbHVlID09PSAnc3RyaW5nJ1xuICAgICAgKSB7XG4gICAgICAgIGNvbnN0IHsgdGFyZ2V0Q2xhc3MgfSA9IGZpZWxkc1twYXJlbnRGaWVsZE5hbWVdO1xuICAgICAgICBjb25zdHJhaW50c1tmaWVsZE5hbWVdID0ge1xuICAgICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICAgIGNsYXNzTmFtZTogdGFyZ2V0Q2xhc3MsXG4gICAgICAgICAgb2JqZWN0SWQ6IGZpZWxkVmFsdWUsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfVxuICAgIHN3aXRjaCAoZmllbGROYW1lKSB7XG4gICAgICBjYXNlICckcG9pbnQnOlxuICAgICAgY2FzZSAnJG5lYXJTcGhlcmUnOlxuICAgICAgICBpZiAodHlwZW9mIGZpZWxkVmFsdWUgPT09ICdvYmplY3QnICYmICFmaWVsZFZhbHVlLl9fdHlwZSkge1xuICAgICAgICAgIGZpZWxkVmFsdWUuX190eXBlID0gJ0dlb1BvaW50JztcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJyRib3gnOlxuICAgICAgICBpZiAoXG4gICAgICAgICAgdHlwZW9mIGZpZWxkVmFsdWUgPT09ICdvYmplY3QnICYmXG4gICAgICAgICAgZmllbGRWYWx1ZS5ib3R0b21MZWZ0ICYmXG4gICAgICAgICAgZmllbGRWYWx1ZS51cHBlclJpZ2h0XG4gICAgICAgICkge1xuICAgICAgICAgIGZpZWxkVmFsdWUgPSBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIF9fdHlwZTogJ0dlb1BvaW50JyxcbiAgICAgICAgICAgICAgLi4uZmllbGRWYWx1ZS5ib3R0b21MZWZ0LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgX190eXBlOiAnR2VvUG9pbnQnLFxuICAgICAgICAgICAgICAuLi5maWVsZFZhbHVlLnVwcGVyUmlnaHQsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF07XG4gICAgICAgICAgY29uc3RyYWludHNbZmllbGROYW1lXSA9IGZpZWxkVmFsdWU7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICckcG9seWdvbic6XG4gICAgICAgIGlmIChmaWVsZFZhbHVlIGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICAgICAgICBmaWVsZFZhbHVlLmZvckVhY2goZ2VvUG9pbnQgPT4ge1xuICAgICAgICAgICAgaWYgKHR5cGVvZiBnZW9Qb2ludCA9PT0gJ29iamVjdCcgJiYgIWdlb1BvaW50Ll9fdHlwZSkge1xuICAgICAgICAgICAgICBnZW9Qb2ludC5fX3R5cGUgPSAnR2VvUG9pbnQnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnJGNlbnRlclNwaGVyZSc6XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0eXBlb2YgZmllbGRWYWx1ZSA9PT0gJ29iamVjdCcgJiZcbiAgICAgICAgICBmaWVsZFZhbHVlLmNlbnRlciAmJlxuICAgICAgICAgIGZpZWxkVmFsdWUuZGlzdGFuY2VcbiAgICAgICAgKSB7XG4gICAgICAgICAgZmllbGRWYWx1ZSA9IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgX190eXBlOiAnR2VvUG9pbnQnLFxuICAgICAgICAgICAgICAuLi5maWVsZFZhbHVlLmNlbnRlcixcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBmaWVsZFZhbHVlLmRpc3RhbmNlLFxuICAgICAgICAgIF07XG4gICAgICAgICAgY29uc3RyYWludHNbZmllbGROYW1lXSA9IGZpZWxkVmFsdWU7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgZmllbGRWYWx1ZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgIGlmIChmaWVsZE5hbWUgPT09ICd3aGVyZScpIHtcbiAgICAgICAgdHJhbnNmb3JtUXVlcnlJbnB1dFRvUGFyc2UoZmllbGRWYWx1ZSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0cmFuc2Zvcm1RdWVyeUNvbnN0cmFpbnRJbnB1dFRvUGFyc2UoXG4gICAgICAgICAgZmllbGRWYWx1ZSxcbiAgICAgICAgICBmaWVsZHMsXG4gICAgICAgICAgZmllbGROYW1lLFxuICAgICAgICAgIGNvbnN0cmFpbnRzXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9KTtcbn07XG5cbmNvbnN0IHRyYW5zZm9ybVF1ZXJ5SW5wdXRUb1BhcnNlID0gKGNvbnN0cmFpbnRzLCBmaWVsZHMpID0+IHtcbiAgaWYgKCFjb25zdHJhaW50cyB8fCB0eXBlb2YgY29uc3RyYWludHMgIT09ICdvYmplY3QnKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgT2JqZWN0LmtleXMoY29uc3RyYWludHMpLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICBjb25zdCBmaWVsZFZhbHVlID0gY29uc3RyYWludHNbZmllbGROYW1lXTtcblxuICAgIGlmIChwYXJzZVF1ZXJ5TWFwW2ZpZWxkTmFtZV0pIHtcbiAgICAgIGRlbGV0ZSBjb25zdHJhaW50c1tmaWVsZE5hbWVdO1xuICAgICAgZmllbGROYW1lID0gcGFyc2VRdWVyeU1hcFtmaWVsZE5hbWVdO1xuICAgICAgY29uc3RyYWludHNbZmllbGROYW1lXSA9IGZpZWxkVmFsdWU7XG5cbiAgICAgIGlmIChmaWVsZE5hbWUgIT09ICdvYmplY3RJZCcpIHtcbiAgICAgICAgZmllbGRWYWx1ZS5mb3JFYWNoKGZpZWxkVmFsdWVJdGVtID0+IHtcbiAgICAgICAgICB0cmFuc2Zvcm1RdWVyeUlucHV0VG9QYXJzZShmaWVsZFZhbHVlSXRlbSwgZmllbGRzKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIGZpZWxkVmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgICB0cmFuc2Zvcm1RdWVyeUNvbnN0cmFpbnRJbnB1dFRvUGFyc2UoZmllbGRWYWx1ZSwgZmllbGRzLCBmaWVsZE5hbWUsIGNvbnN0cmFpbnRzKTtcbiAgICB9XG4gIH0pO1xufTtcblxuZXhwb3J0IHsgdHJhbnNmb3JtUXVlcnlDb25zdHJhaW50SW5wdXRUb1BhcnNlLCB0cmFuc2Zvcm1RdWVyeUlucHV0VG9QYXJzZSB9O1xuIl19