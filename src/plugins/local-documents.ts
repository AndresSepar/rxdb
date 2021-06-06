/**
 * This plugin adds the local-documents-support
 * Local documents behave equal then with pouchdb
 * @link https://pouchdb.com/guides/local-documents.html
 */

import objectPath from 'object-path';

import {
    createRxDocumentConstructor,
    basePrototype
} from '../rx-document';
import {
    RxChangeEvent
} from '../rx-change-event';
import {
    createDocCache
} from '../doc-cache';
import {
    newRxError,
    newRxTypeError
} from '../rx-error';
import {
    clone,
    flatClone,
    getFromMapOrThrow,
    now
} from '../util';

import type {
    RxCollection,
    RxDatabase,
    RxDocument,
    RxDocumentWriteData,
    RxLocalDocumentData,
    RxPlugin,
    RxStorageKeyObjectInstance
} from '../types';

import {
    isRxDatabase
} from '../rx-database';
import {
    isRxCollection
} from '../rx-collection';

import {
    filter,
    map,
    distinctUntilChanged,
    startWith,
    mergeMap
} from 'rxjs/operators';
import { Observable } from 'rxjs';
import { POUCHDB_LOCAL_PREFIX } from '../rx-storage-pouchdb';
import {
    findLocalDocument,
    writeSingleLocal
} from '../rx-storage-helper';

const DOC_CACHE_BY_PARENT = new WeakMap();
const _getDocCache = (parent: any) => {
    if (!DOC_CACHE_BY_PARENT.has(parent)) {
        DOC_CACHE_BY_PARENT.set(
            parent,
            createDocCache()
        );
    }
    return DOC_CACHE_BY_PARENT.get(parent);
};
const CHANGE_SUB_BY_PARENT = new WeakMap();
const _getChangeSub = (parent: any) => {
    if (!CHANGE_SUB_BY_PARENT.has(parent)) {
        const sub = parent.$
            .pipe(
                filter(cE => (cE as RxChangeEvent).isLocal)
            )
            .subscribe((cE: RxChangeEvent) => {
                const docCache = _getDocCache(parent);
                const doc = docCache.get(cE.documentId);
                if (doc) doc._handleChangeEvent(cE);
            });
        parent._subs.push(sub);
        CHANGE_SUB_BY_PARENT.set(
            parent,
            sub
        );
    }
    return CHANGE_SUB_BY_PARENT.get(parent);
};

const RxDocumentParent = createRxDocumentConstructor() as any;
export class RxLocalDocument extends RxDocumentParent {
    constructor(
        public readonly id: string,
        jsonData: any,
        public readonly parent: RxCollection | RxDatabase
    ) {
        super(null, jsonData);
    }
}

function _getKeyObjectStorageInstanceByParent(parent: any): RxStorageKeyObjectInstance<any, any> {
    if (isRxDatabase(parent)) {
        return (parent as RxDatabase<{}>).localDocumentsStore; // database
    } else {
        return (parent as RxCollection).localDocumentsStore; // collection
    }
}

const RxLocalDocumentPrototype: any = {
    toPouchJson(
        this: any
    ) {
        const data = clone(this._data);
        data._id = POUCHDB_LOCAL_PREFIX + this.id;
    },
    get isLocal() {
        return true;
    },

    //
    // overwrites
    //

    _handleChangeEvent(
        this: any,
        changeEvent: RxChangeEvent
    ) {
        if (changeEvent.documentId !== this.primary) {
            return;
        }
        switch (changeEvent.operation) {
            case 'UPDATE':
                const newData = clone(changeEvent.documentData);
                this._dataSync$.next(clone(newData));
                break;
            case 'DELETE':
                // remove from docCache to assure new upserted RxDocuments will be a new instance
                const docCache = _getDocCache(this.parent);
                docCache.delete(this.primary);
                this._deleted$.next(true);
                break;
        }
    },

    get allAttachments$() {
        // this is overwritten here because we cannot re-set getters on the prototype
        throw newRxError('LD1', {
            document: this
        });
    },
    get primaryPath() {
        return 'id';
    },
    get primary() {
        return this.id;
    },
    get $() {
        return (this as RxDocument)._dataSync$.asObservable();
    },
    $emit(this: any, changeEvent: RxChangeEvent) {
        return this.parent.$emit(changeEvent);
    },
    get(this: RxDocument, objPath: string) {
        if (!this._data) return undefined;
        if (typeof objPath !== 'string') {
            throw newRxTypeError('LD2', {
                objPath
            });
        }

        let valueObj = objectPath.get(this._data, objPath);
        valueObj = clone(valueObj);
        return valueObj;
    },
    get$(this: RxDocument, path: string) {
        if (path.includes('.item.')) {
            throw newRxError('LD3', {
                path
            });
        }
        if (path === this.primaryPath)
            throw newRxError('LD4');

        return this._dataSync$
            .pipe(
                map(data => objectPath.get(data, path)),
                distinctUntilChanged()
            );
    },
    set(this: RxDocument, objPath: string, value: any) {
        if (!value) {
            // object path not set, overwrite whole data
            const data: any = clone(objPath);
            data._rev = this._data._rev;
            this._data = data;
            return this;
        }
        if (objPath === '_id') {
            throw newRxError('LD5', {
                objPath,
                value
            });
        }
        if (Object.is(this.get(objPath), value)) return;
        objectPath.set(this._data, objPath, value);
        return this;
    },
    _saveData(this: RxLocalDocument, newData: RxLocalDocumentData) {
        const oldData = this._dataSync$.getValue();

        const storageInstance = _getKeyObjectStorageInstanceByParent(this.parent);
        const startTime = now();

        newData._id = this.id;

        return storageInstance.bulkWrite([newData])
            .then((res) => {
                const endTime = now();
                const docResult = res.success.get(newData._id);
                if (!docResult) {
                    throw getFromMapOrThrow(res.error, newData._id);
                }
                newData._rev = docResult._rev;
                const changeEvent = new RxChangeEvent(
                    'UPDATE',
                    this.id,
                    clone(newData),
                    isRxDatabase(this.parent) ? this.parent.token : this.parent.database.token,
                    isRxCollection(this.parent) ? this.parent.name : null as any,
                    true,
                    startTime,
                    endTime,
                    oldData,
                    this
                );
                this.$emit(changeEvent);
            });
    },

    remove(this: any): Promise<void> {
        const startTime = now();
        const storageInstance = _getKeyObjectStorageInstanceByParent(this.parent);
        const writeData: RxDocumentWriteData<{ _id: string }> = {
            _id: this.id,
            _deleted: true,
            _rev: this._data._rev,
            _attachments: {}
        };
        return writeSingleLocal(storageInstance, writeData)
            .then(() => {
                _getDocCache(this.parent).delete(this.id);
                const endTime = now();
                const changeEvent = new RxChangeEvent(
                    'DELETE',
                    this.id,
                    clone(this._data),
                    isRxDatabase(this.parent) ? this.parent.token : this.parent.database.token,
                    isRxCollection(this.parent) ? this.parent.name : null,
                    true,
                    startTime,
                    endTime,
                    null,
                    this
                );
                this.$emit(changeEvent);
            });
    }
};


let INIT_DONE = false;
const _init = () => {
    if (INIT_DONE) return;
    else INIT_DONE = true;

    // add functions of RxDocument
    const docBaseProto = basePrototype;
    const props = Object.getOwnPropertyNames(docBaseProto);
    props.forEach(key => {
        const exists = Object.getOwnPropertyDescriptor(RxLocalDocumentPrototype, key);
        if (exists) return;
        const desc: any = Object.getOwnPropertyDescriptor(docBaseProto, key);
        Object.defineProperty(RxLocalDocumentPrototype, key, desc);
    });


    /**
     * overwrite things that not work on local documents
     * with throwing function
     */
    const getThrowingFun = (k: string) => () => {
        throw newRxError('LD6', {
            functionName: k
        });
    };
    [
        'populate',
        'update',
        'putAttachment',
        'getAttachment',
        'allAttachments'
    ].forEach((k: string) => RxLocalDocumentPrototype[k] = getThrowingFun(k));
};

RxLocalDocument.create = (id: string, data: any, parent: any) => {
    _init();
    _getChangeSub(parent);

    const newDoc = new RxLocalDocument(id, data, parent);
    newDoc.__proto__ = RxLocalDocumentPrototype;
    _getDocCache(parent).set(id, newDoc);
    return newDoc;
};

/**
 * save the local-document-data
 * throws if already exists
 */
function insertLocal(
    this: RxDatabase | RxCollection,
    // TODO insertLocal should assume the _id is inside of the doc data
    id: string,
    docData: RxLocalDocumentData
): Promise<RxLocalDocument> {
    if (isRxCollection(this) && this._isInMemory) {
        return this._parentCollection.insertLocal(id, docData);
    }

    return (this as any).getLocal(id)
        .then((existing: any) => {

            if (existing) {
                throw newRxError('LD7', {
                    id,
                    data: docData
                });
            }

            // create new one
            docData = flatClone(docData);
            docData._id = id;

            const startTime = now();

            return writeSingleLocal(
                _getKeyObjectStorageInstanceByParent(this),
                docData
            ).then(res => {
                docData._rev = res._rev;
                const newDoc = RxLocalDocument.create(id, docData, this);
                const endTime = now();
                const changeEvent = new RxChangeEvent(
                    'INSERT',
                    id,
                    clone(docData),
                    isRxDatabase(this) ? this.token : this.database.token,
                    isRxCollection(this) ? this.name : '',
                    true,
                    startTime,
                    endTime,
                    undefined,
                    newDoc
                );
                this.$emit(changeEvent);
                return newDoc;
            });
        });
}

/**
 * save the local-document-data
 * overwrites existing if exists
 */
function upsertLocal(this: any, id: string, data: any): Promise<RxLocalDocument> {
    if (isRxCollection(this) && this._isInMemory) {
        return this._parentCollection.upsertLocal(id, data);
    }

    return this.getLocal(id)
        .then((existing: RxDocument) => {
            if (!existing) {
                // create new one
                const docPromise = this.insertLocal(id, data);
                return docPromise;
            } else {
                // update existing
                data._rev = existing._data._rev;
                return existing.atomicUpdate(() => data).then(() => existing);
            }
        });
}

function getLocal(this: any, id: string): Promise<RxLocalDocument | null> {
    if (isRxCollection(this) && this._isInMemory) {
        return this._parentCollection.getLocal(id);
    }

    const storageInstance = _getKeyObjectStorageInstanceByParent(this);
    const docCache = _getDocCache(this);

    // check in doc-cache
    const found = docCache.get(id);
    if (found) {
        return Promise.resolve(found);
    }

    // if not found, check in pouch
    return findLocalDocument(storageInstance, id)
        .then((docData) => {
            if (!docData) {
                return null;
            }
            const doc = RxLocalDocument.create(id, docData, this);
            return doc;
        })
        .catch(() => null);
}

function getLocal$(this: RxCollection, id: string): Observable<RxLocalDocument | null> {
    return this.$.pipe(
        startWith(null),
        mergeMap(async (cE: RxChangeEvent | null) => {
            if (cE) {
                return {
                    changeEvent: cE
                };
            } else {
                const doc = await this.getLocal(id);
                return {
                    doc: doc
                };
            }
        }),
        mergeMap(async (changeEventOrDoc) => {
            if (changeEventOrDoc.changeEvent) {
                const cE = changeEventOrDoc.changeEvent;
                if (!cE.isLocal || cE.documentId !== id) {
                    return {
                        use: false
                    };
                } else {
                    const doc = cE.rxDocument ? cE.rxDocument : await this.getLocal(id);
                    return {
                        use: true,
                        doc: doc
                    };
                }
            } else {
                return {
                    use: true,
                    doc: changeEventOrDoc.doc
                };
            }
        }),
        filter(filterFlagged => filterFlagged.use),
        map(filterFlagged => {
            return filterFlagged.doc;
        })
    );
}

export const rxdb = true;
export const prototypes = {
    RxCollection: (proto: any) => {
        proto.insertLocal = insertLocal;
        proto.upsertLocal = upsertLocal;
        proto.getLocal = getLocal;
        proto.getLocal$ = getLocal$;
    },
    RxDatabase: (proto: any) => {
        proto.insertLocal = insertLocal;
        proto.upsertLocal = upsertLocal;
        proto.getLocal = getLocal;
        proto.getLocal$ = getLocal$;
    }
};
export const overwritable = {};

export const RxDBLocalDocumentsPlugin: RxPlugin = {
    name: 'local-documents',
    rxdb,
    prototypes,
    overwritable
};
