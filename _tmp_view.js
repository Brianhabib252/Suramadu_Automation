'use strict';

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
class BaseModule {
}
function formatMap(templateString, valueMap) {
    // Use a regular expression to find all placeholders in the template string
    const regex = /\{([^}]+)\}/g;
    // Replace each placeholder with its corresponding value from the valueMap
    return templateString.replace(regex, (match, key) => {
        if (Object.prototype.hasOwnProperty.call(valueMap, key)) {
            const value = valueMap[key];
            // Convert the value to a string if it's not a string already
            return value !== undefined && value !== null ? String(value) : '';
        }
        else {
            // Handle missing keys
            throw new Error(`Key '${key}' not found in valueMap.`);
        }
    });
}
function setValueByPath(data, keys, value) {
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (key.endsWith('[]')) {
            const keyName = key.slice(0, -2);
            if (!(keyName in data)) {
                if (Array.isArray(value)) {
                    data[keyName] = Array.from({ length: value.length }, () => ({}));
                }
                else {
                    throw new Error(`Value must be a list given an array path ${key}`);
                }
            }
            if (Array.isArray(data[keyName])) {
                const arrayData = data[keyName];
                if (Array.isArray(value)) {
                    for (let j = 0; j < arrayData.length; j++) {
                        const entry = arrayData[j];
                        setValueByPath(entry, keys.slice(i + 1), value[j]);
                    }
                }
                else {
                    for (const d of arrayData) {
                        setValueByPath(d, keys.slice(i + 1), value);
                    }
                }
            }
            return;
        }
        else if (key.endsWith('[0]')) {
            const keyName = key.slice(0, -3);
            if (!(keyName in data)) {
                data[keyName] = [{}];
            }
            const arrayData = data[keyName];
