/**
 * M1 Helper - Simplified MobX Setup
 *
 * Fixed version that doesn't conflict with existing getters/setters
 */

import { observable, makeObservable, action, computed, observe } from 'mobx';
import { PropertyType, PropertyMetadata } from '../types';
import { getContext } from '../context';

/**
 * M1 - Make properties observable with proper MobX setup
 *
 * Simplified version that respects existing getters/setters
 */
export function M1(
  target: any,
  propertyMetadata: Map<string, PropertyMetadata>,
  referenceMetadata?: Map<string, any>
): void {
  const annotations: any = {};

  // Helper to check if property has a getter
  const hasGetter = (propName: string): boolean => {
    let obj = target;
    while (obj) {
      const descriptor = Object.getOwnPropertyDescriptor(obj, propName);
      if (descriptor && descriptor.get) return true;
      obj = Object.getPrototypeOf(obj);
      if (obj === Object.prototype) break;
    }
    return false;
  };

  // Helper to check if property has a setter
  const hasSetter = (propName: string): boolean => {
    let obj = target;
    while (obj) {
      const descriptor = Object.getOwnPropertyDescriptor(obj, propName);
      if (descriptor && descriptor.set) return true;
      obj = Object.getPrototypeOf(obj);
      if (obj === Object.prototype) break;
    }
    return false;
  };

  // Skip if target has its own observability setup
  // This allows models like Task to handle their own MobX setup
  if (target.setupObservability || target._hasCustomObservability) {
    getContext().modelDebugLogger?.logDebug(`${target.constructor.name} has custom observability, skipping M1`);
    return;
  }

  // Process each property based on its type
  for (const [propName, metadata] of propertyMetadata) {
    const hasCustomGetter = hasGetter(propName);
    const hasCustomSetter = hasSetter(propName);

    // If property has custom getter/setter, respect it
    if (hasCustomGetter && hasCustomSetter) {
      // Property is fully managed, skip it
      continue;
    }

    switch (metadata.type) {
      case PropertyType.property:
      case PropertyType.ephemeralProperty:
        if (hasCustomGetter) {
          // Has getter but no setter - mark as computed
          annotations[propName] = computed;
        } else {
          // Regular observable property
          annotations[propName] = observable;
        }
        break;

      case PropertyType.reference:
        // Foreign key ID property
        const idPropName = propName.endsWith('Id') ? propName : `${propName}Id`;
        if (!hasGetter(idPropName) && !hasSetter(idPropName)) {
          annotations[idPropName] = observable;
        }
        break;

      case PropertyType.referenceModel:
        // Computed getter for referenced model
        if (!hasCustomGetter && !hasCustomSetter) {
          annotations[propName] = computed;
        }
        break;

      case PropertyType.referenceCollection:
        // Observable collection
        if (!hasCustomGetter && !hasCustomSetter) {
          annotations[propName] = observable;
        }
        break;

      case PropertyType.backReference:
        // Computed back-reference
        if (!hasCustomGetter && !hasCustomSetter) {
          annotations[propName] = computed;
        }
        break;

      case PropertyType.referenceArray:
        // Observable array of IDs
        if (!propName.endsWith('Ids')) {
          const idsPropName = `${propName}Ids`;
          if (!hasGetter(idsPropName) && !hasSetter(idsPropName)) {
            annotations[idsPropName] = observable;
          }
        }
        if (!hasCustomGetter && !hasCustomSetter) {
          annotations[propName] = observable;
        }
        break;
    }
  }

  // Add standard model properties only if they don't exist
  if (!hasGetter('id') && !hasSetter('id')) {
    annotations.id = observable;
  }
  if (!hasGetter('createdAt') && !hasSetter('createdAt')) {
    annotations.createdAt = observable;
  }
  if (!hasGetter('updatedAt') && !hasSetter('updatedAt')) {
    annotations.updatedAt = observable;
  }
  if (!hasGetter('modifiedProperties') && !hasSetter('modifiedProperties')) {
    annotations.modifiedProperties = observable;
  }

  // Add actions only if methods exist and aren't already actions
  const actionMethods = ['propertyChanged', 'markAsPersisted', 'clearChanges', 'updateFromData'];

  for (const methodName of actionMethods) {
    if (typeof target[methodName] === 'function') {
      annotations[methodName] = action;
    }
  }

  // Log setup for debugging
  const modelName = target.constructor.name;
  const observableProps = Object.keys(annotations).filter((k) => annotations[k] === observable);
  const computedProps = Object.keys(annotations).filter((k) => annotations[k] === computed);

  getContext().modelDebugLogger?.logObservableSetup(modelName, observableProps, computedProps);

  // Merge any extra annotations declared by the model (e.g., computed for query getters)
  if (target._extraMobxAnnotations && typeof target._extraMobxAnnotations === 'object') {
    Object.assign(annotations, target._extraMobxAnnotations);
  }

  // Apply MobX decorators
  try {
    // Only apply if we have annotations to apply
    if (Object.keys(annotations).length > 0) {
      makeObservable(target, annotations);

      // Bridge MobX's observable setter to `propertyChanged()` so the
      // dynamic-class mutation path sees direct assignments like
      // `layer.position = newPos` — i.e., the transaction queue gets an
      // update and the server eventually sees it.
      //
      // History: the old hand-coded models wired setters via
      // `setupSimplePropertyTracking` which overrode MobX's accessors and
      // broke reactivity — that function was correctly kept off the
      // schema-driven dynamic-class path. The intended replacement was
      // "use `store.mutate.slideLayers.update(...)` from callers," but a
      // large amount of existing product code (drag, resize, formatting,
      // keyboard nudge, AI tools, etc.) still assigns properties directly,
      // and making that silently not sync was the regression that broke
      // all slide-layer edits.
      //
      // `observe()` attaches a post-set listener WITHOUT replacing MobX's
      // accessors — so the observable keeps its normal reactivity and we
      // get a synchronous change event we can forward to
      // `propertyChanged()`. We scope it to `PropertyType.property`
      // (persisted fields) so ephemeral UI state and computed/reference
      // virtual fields don't leak into `modifiedProperties`.
      //
      // Construction-time writes (the constructor's initial field
      // population from wire data) also fire `observe` — so we gate with
      // `target._isNew` and a transient `_isConstructing` flag: any change
      // that happens before the model is marked persisted is an initial
      // hydration, not a user edit.
      if (!target._hasCustomObservability) {
        for (const [propName, metadata] of propertyMetadata) {
          if (metadata.type !== PropertyType.property) continue;
          // Only `annotations[propName] === observable` entries are
          // safe to `observe()`. DON'T gate on
          // `Object.getOwnPropertyDescriptor(target, propName).get/set` —
          // `makeObservable(target, annotations)` has ALREADY installed
          // its own getter/setter by this point, so that descriptor
          // check flags every field as "custom" and silently skips
          // every observer. That was the root cause of `input: {}` on
          // the wire: `modifiedProperties` stayed empty for dynamic
          // models, the transaction queue couldn't find any changes to
          // send, and the server acked a no-op mutation.
          if (!(propName in annotations)) continue;
          if (annotations[propName] !== observable) continue;
          try {
            observe(target, propName as any, (change: any) => {
              // Only track updates, not add/delete. For scalar observables,
              // MobX emits `{ type: 'update', oldValue, newValue }`.
              if (change.type !== 'update') return;
              // Skip initial hydration writes. `_isNew` stays true until
              // the model is `markAsPersisted()`, and the first wave of
              // setters runs during construction BEFORE this observer
              // would exist (observers are installed now, on this line);
              // but defensively still gate, because callers that
              // pre-construct models with partial data then bulk-assign
              // would otherwise spuriously fill `modifiedProperties`.
              if (target._isConstructing) return;
              if (typeof target.propertyChanged === 'function') {
                target.propertyChanged(
                  propName,
                  change.oldValue,
                  change.newValue,
                );
              }
            });
          } catch {
            // If a property isn't observable for any reason (e.g. it
            // was filtered out by the annotations logic but still shows
            // up in metadata), silently skip — propertyChanged tracking
            // is best-effort, not a correctness guarantee.
          }
        }
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    getContext().modelDebugLogger?.logError(modelName, 'OBSERVABLE_SETUP', errorMessage, {
      annotations: Object.keys(annotations),
      target: Object.keys(target),
    });
    throw error;
  }
}

/**
 * Setup simple property tracking for change detection
 * Only for properties without existing getters/setters
 */
function setupSimplePropertyTracking(
  target: any,
  propertyMetadata: Map<string, PropertyMetadata>
): void {
  for (const [propName, metadata] of propertyMetadata) {
    // Only track regular properties
    if (
      metadata.type !== PropertyType.property &&
      metadata.type !== PropertyType.ephemeralProperty
    ) {
      continue;
    }

    // Check if property already has custom getter/setter
    const descriptor = Object.getOwnPropertyDescriptor(target, propName);
    if (descriptor && (descriptor.get || descriptor.set)) {
      // Property already managed, skip
      continue;
    }

    // Check prototype chain
    let proto = Object.getPrototypeOf(target);
    let hasCustomAccessor = false;
    while (proto && proto !== Object.prototype) {
      const protoDescriptor = Object.getOwnPropertyDescriptor(proto, propName);
      if (protoDescriptor && (protoDescriptor.get || protoDescriptor.set)) {
        hasCustomAccessor = true;
        break;
      }
      proto = Object.getPrototypeOf(proto);
    }

    if (hasCustomAccessor) {
      continue;
    }

    // Only add tracking if property exists and isn't already tracked
    if (propName in target) {
      const currentValue = target[propName];

      // Store value in a private field
      const privateField = `_tracked_${propName}`;
      target[privateField] = currentValue;

      // Create simple getter/setter for tracking
      Object.defineProperty(target, propName, {
        get() {
          return this[privateField];
        },
        set(newValue) {
          const oldValue = this[privateField];
          if (oldValue !== newValue) {
            this[privateField] = newValue;

            // Only track changes for non-ephemeral properties
            if (metadata.type === PropertyType.property && this.propertyChanged) {
              this.propertyChanged(propName, oldValue, newValue);
            }
          }
        },
        enumerable: true,
        configurable: true,
      });
    }
  }
}

/**
 * Helper to make a class observable
 * For classes that don't have custom observability
 */
export function makeModelObservable(
  modelClass: any,
  propertyMetadata: Map<string, PropertyMetadata>,
  referenceMetadata?: Map<string, any>
): any {
  // Check if class already handles observability
  if (modelClass.prototype.setupObservability || modelClass.prototype._hasCustomObservability) {
    return modelClass;
  }

  // Create wrapper class
  const WrappedClass = class extends modelClass {
    constructor(...args: any[]) {
      super(...args);
      M1(this, propertyMetadata, referenceMetadata);
    }
  };

  // Preserve class name
  Object.defineProperty(WrappedClass, 'name', {
    value: modelClass.name,
    configurable: true,
  });

  // Copy static properties
  Object.setPrototypeOf(WrappedClass, modelClass);

  return WrappedClass;
}

/**
 * Utility to check if a property is observable
 */
export function isObservableProperty(
  target: any,
  propName: string,
  propertyMetadata: Map<string, PropertyMetadata>
): boolean {
  const metadata = propertyMetadata.get(propName);
  if (!metadata) return false;

  return [
    PropertyType.property,
    PropertyType.ephemeralProperty,
    PropertyType.referenceCollection,
    PropertyType.referenceArray,
  ].includes(metadata.type);
}

/**
 * Utility to get computed properties
 */
export function getComputedProperties(propertyMetadata: Map<string, PropertyMetadata>): string[] {
  const computed: string[] = [];

  for (const [propName, metadata] of propertyMetadata) {
    if (
      metadata.type === PropertyType.referenceModel ||
      metadata.type === PropertyType.backReference
    ) {
      computed.push(propName);
    }
  }

  return computed;
}
