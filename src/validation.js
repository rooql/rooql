import { fail } from './errors.js';

export function object(value, keys, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_SHAPE', 'Expected an object', path);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail('UNSUPPORTED_FEATURE', `Unsupported property ${key}`, path);
  }
}

export function string(value, path, nonempty = false) {
  if (typeof value !== 'string' || (nonempty && !value.length)) {
    fail('INVALID_SHAPE', `Expected a ${nonempty ? 'nonempty ' : ''}string`, path);
  }
}

export function array(value, path) {
  if (!Array.isArray(value)) fail('INVALID_SHAPE', 'Expected an array', path);
}

export function metadata(value, path) {
  for (const key of ['description', 'label']) {
    if (value[key] !== undefined) string(value[key], `${path}.${key}`);
  }
  const context = value.ai_context;
  if (context !== undefined && typeof context !== 'string') {
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      fail('INVALID_SHAPE', 'Expected an AI context string or object', `${path}.ai_context`);
    }
    if (context.instructions !== undefined) string(context.instructions, `${path}.ai_context.instructions`);
    for (const key of ['synonyms', 'examples']) {
      if (context[key] !== undefined) {
        array(context[key], `${path}.ai_context.${key}`);
        context[key].forEach((item, index) => string(item, `${path}.ai_context.${key}[${index}]`));
      }
    }
  }
  // Vendor extensions are validated for shape and otherwise ignored, as the spec allows.
  if (value.custom_extensions !== undefined) {
    array(value.custom_extensions, `${path}.custom_extensions`);
    value.custom_extensions.forEach((extension, index) => {
      object(extension, ['vendor_name', 'data'], `${path}.custom_extensions[${index}]`);
      string(extension.vendor_name, `${path}.custom_extensions[${index}].vendor_name`, true);
      if (extension.data !== undefined) string(extension.data, `${path}.custom_extensions[${index}].data`);
    });
  }
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
