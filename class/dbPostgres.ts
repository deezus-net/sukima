import { Client } from 'pg';
import {Db} from '../interfaces/db';
import {DbColumn} from '../interfaces/dbColumn';
import {DbHost} from '../interfaces/dbHost';
import {DbInterface} from '../interfaces/dbInterface';
import {DbTable} from '../interfaces/dbTable';
import {ColumnType} from './columnType';
import {checkDbDiff, distinct, trimDbProperties} from './utility';
 
export class DbPostgres implements DbInterface {
    private client: Client;
    private dbHost;

    constructor(dbHost: DbHost) {
        try {
            this.dbHost = dbHost;
            this.client = new Client({
                user: dbHost.user,
                host: dbHost.host,
                database: dbHost.database,
                password: dbHost.password
            });
        } catch (e) {
            console.log(e);
        }
    }

    /**
     *
     * @returns {Promise<boolean>}
     */
    public async connect() {
        await this.client.connect();
        return true;
    }

    /**
     *
     * @returns {Promise<boolean>}
     */
    public async close() {
        await this.client.end();
        return true;
    }

    /**
     *
     * @param {Db} db
     * @param queryOnly
     * @returns {Promise<boolean>}
     */
    public async create(db: Db, queryOnly: boolean) {
        const query = this.createQuery(db.tables);
        if (!queryOnly) {
            await this.client.query('BEGIN');
            await this.client.query(query);
            await this.client.query('COMMIT');
        }
        return query;
    }

    /**
     * 
     * @param {Db} db
     * @param {boolean} queryOnly
     * @returns {Promise<string>}
     */
    public async drop(db: Db, queryOnly: boolean) {
        const queries = [];
        for (const tableName of Object.keys(db.tables)){
            queries.push(`DROP TABLE IF EXISTS "${tableName}" CASCADE;`);
        }
        const execQuery = queries.join('\n');

        if (!queryOnly) {
            await this.client.query('BEGIN');
            await this.client.query(execQuery);
            await this.client.query('COMMIT');
        }
        return execQuery;
    }

    /**
     *
     * @param {Db} db
     * @returns {Promise<DiffResult>}
     */
    public async diff(db: Db) {
        const orgDb = await this.extract();
        return checkDbDiff(orgDb, db);
    }

    /**
     *
     * @returns {Promise<{tables: {[p: string]: DbTable}}>}
     */
    public async extract() {
        const tables: { [key: string]: DbTable } = {};
        const tData = await this.client.query('SELECT relname FROM "pg_stat_user_tables" WHERE schemaname=\'public\'');
        for (const row of tData.rows) {
            tables[row['relname']] = {
                columns: {},
                indexes: {}
            };
        }
        
        // get sequence list
        const seqData = await this.client.query('SELECT sequence_name FROM information_schema.sequences');
        const sequences = seqData.rows.map(row => row['sequence_name']);
        

        for (const tableName of Object.keys(tables)) {
            const table = tables[tableName];

            // get column list
            let query = `
                    SELECT 
                        column_name, 
                        data_type, 
                        is_nullable, 
                        character_maximum_length, 
                        is_identity, 
                        column_default 
                    FROM 
                        information_schema.columns 
                    WHERE 
                        table_name = $1`;
            const tableData = await this.client.query(query, [tableName]);

            for (const row of tableData.rows) {
                const id = sequences.filter(seq => (row['column_default'] || '').indexOf(seq) !== -1).length > 0;
                let type = id ? 'serial' : row['data_type'];
                const length = row['character_maximum_length'] ? parseInt(row['character_maximum_length'], 10) : 0;

                type = ColumnType.postgreSql[type] ? ColumnType.postgreSql[type] : type;

                const column: DbColumn = {
                    type: type,
                    id: id,
                    length: length,
                    notNull: row['is_nullable'] === 'NO'
                };
                if (row['column_default'] && !id) {
                    column.default = row['column_default'];
                }
                tables[tableName].columns[row['column_name']] = column;
            }

            // get primary key list
            query = `
                SELECT
                    ccu.column_name 
                FROM
                    information_schema.table_constraints tc
                INNER JOIN
                    information_schema.constraint_column_usage ccu
                ON
                    tc.table_catalog = ccu.table_catalog
                AND
                    tc.table_schema = ccu.table_schema
                AND
                    tc.table_name = ccu.table_name
                AND
                    tc.constraint_name = ccu.constraint_name
                WHERE
                    tc.table_catalog = $1
                AND
                    tc.table_name = $2
                AND
                    tc.constraint_type = 'PRIMARY KEY'`;
            const pkData = await this.client.query(query, [this.dbHost.database, tableName]);

            for (const row of pkData.rows) {
                if (tables[tableName].columns[row['column_name']]) {
                    tables[tableName].columns[row['column_name']].pk = true;
                }
            }

            // get index list
            query = `
                SELECT 
                    indexname, 
                    indexdef 
                FROM 
                    pg_indexes 
                WHERE tablename = $1`;
            const indexData = await this.client.query(query, [tableName]);

            for (const row of indexData.rows) {
                const indexdef = row['indexdef'];
                const indexName = row['indexname'];
                if (!tables[tableName].indexes[indexName]) {
                    tables[tableName].indexes[indexName] = {
                        unique: indexdef.indexOf('UNIQUE INDEX') !== -1,
                        columns: {}
                    };
                }

                const m = (indexdef.match(/\(.*\)/) || [])[0];
                if (!m) {
                    continue;
                }
                for (const col of m.replace('(', '').replace(')', '').split(',')) {
                    const tmp = col.trim().split(' ');
                    if (tables[tableName].columns[tmp[0]]) {
                        tables[tableName].indexes[indexName].columns[tmp[0]] = tmp.Length > 1 ? tmp[1] : 'ASC';
                    }
                }
            }

            // remove primarykey index
            const pkColumns: string[] = [];
            for (const columnName of Object.keys(table.columns)) {
                if (table.columns[columnName].pk) {
                    pkColumns.push(columnName);
                }
            }

            for (const indexName of Object.keys(table.indexes)) {
                const columns = [];
                for (const columnName of Object.keys(table.indexes[indexName].columns)) {
                    columns.push(columnName);
                }
                if (columns.toString() === pkColumns.toString()) {
                    delete tables[tableName].indexes[indexName];
                }
            }

            // get check list
            query = `
                SELECT
                    co.consrc,
                    co.conname
                FROM
                    pg_constraint AS co 
                INNER JOIN
                    pg_class AS cl
                ON
                    co.conrelid = cl.oid
                WHERE
                    co.contype = 'c'
                AND
                    cl.relname = $1`;
            const checkData = await this.client.query(query, [tableName]);
            for (const row of checkData.rows) {
                const consrc = (row['consrc'].match(/\((.*)\)/) || [])[1] || row['consrc'];
                for (const colName of Object.keys(table.columns)) {
                    if (consrc.indexOf(colName) !== -1) {
                        table.columns[colName].check = consrc;
                        table.columns[colName].checkName = row['conname'];
                    }
                }
            }

            // get foreign key list
            query = `
                SELECT
                    tc.constraint_name,
                    tc.table_name,
                    kcu.column_name,
                    ccu.table_name AS foreign_table_name,
                    ccu.column_name AS foreign_column_name,
                    pc.confupdtype,
                    pc.confdeltype
                FROM
                    information_schema.table_constraints AS tc
                INNER JOIN
                    information_schema.key_column_usage AS kcu
                ON
                    tc.constraint_name = kcu.constraint_name
                INNER JOIN
                    information_schema.constraint_column_usage AS ccu
                ON
                    ccu.constraint_name = tc.constraint_name
                INNER JOIN
                    pg_constraint AS pc
                ON
                    tc.constraint_name = pc.conname
                WHERE
                    tc.constraint_type = 'FOREIGN KEY'
                AND
                    tc.table_name = $1`;
            const fkData = await this.client.query(query, [tableName]);
            const conf = {
                a: '',
                r: 'RESTRICT',
                c: 'CASCADE',
                n: 'SET NULL',
                d: 'SET DEFAULT'
            };
            for (const row of fkData.rows) {

                const columnName = row['column_name'];
                if (!tables[tableName].columns[columnName]) {
                    continue;
                }
                const update = conf[row['confupdtype']] || '';
                const del = conf[row['confdeltype']] || '';

                const key = row['foreign_table_name'] + '.' + row['foreign_column_name'];
                tables[tableName].columns[columnName].fk = {};
                tables[tableName].columns[columnName].fk[row['constraint_name']] = {
                    table: row['foreign_table_name'],
                    column: row['foreign_column_name'],
                    update: update,
                    delete: del
                };
            }
        }

        const db = {tables: tables};
        trimDbProperties(db);
        return db;
    }

    /**
     *
     * @param {Db} db
     * @returns {any}
     */
    public query(db: Db) {
        return this.createQuery(db.tables);
    }

    /**
     *
     * @param {Db} db
     * @param queryOnly
     * @returns {Promise<boolean>}
     */
    public async reCreate(db: Db, queryOnly: boolean) {
        const query = [];
        const tables = {};
        const data = await this.client.query('SELECT relname FROM "pg_stat_user_tables" WHERE schemaname=\'public\'');
        for (const row of data.rows) {
            query.push(`DROP TABLE "${row['relname']}" CASCADE;`);
        }
        query.push(this.createQuery(db.tables));

        const execQuery = query.join('\n');
        
        if (!queryOnly) {
            await this.client.query('BEGIN;');
            await this.client.query(execQuery);
            await this.client.query('COMMIT;');
        }
        return execQuery;
    }

    /**
     *
     * @param {Db} db
     * @param queryOnly
     * @param dropTable
     * @returns {Promise<void>}
     */
    public async update(db: Db, queryOnly: boolean, dropTable = false) {
        const diff = await this.diff(db);
        const query = [];
        const createFkQuery = [];
        const dropFkQuery = [];

        
        // add tables
        if (Object.keys(diff.addedTables).length > 0) {
            query.push(this.createQuery(diff.addedTables));
        }

        for (const tableName of Object.keys(diff.modifiedTables)) {
            const table = diff.modifiedTables[tableName];

            // add columns
            for (const columnName of Object.keys(table.addedColumns)) {
                const column = table.addedColumns[columnName];
                let type = column.id ? 'serial' : column.type;
                if (column.length > 0) {
                    type += `(${column.length})`;
                }
                const check = column.check ? ` CHECK(${column.check}) ` : '';
                const def = column.default ? ` DEFAULT ${column.default} ` : '';
                
                query.push(`ALTER TABLE`);
                query.push(`    "${tableName}"`);
                query.push(`ADD COLUMN "${columnName}" ${type}${(column.notNull ? ' NOT NULL' : '')}${check}${def};`);

                for (const fkName of Object.keys(column.fk || {})) {
                    const fk = column.fk[fkName];
                    createFkQuery.push(DbPostgres.createAlterForeignKey(fkName, tableName, columnName, fk.table, fk.column, fk.update, fk.delete));
                }
            }

            // modify columns
            for (const columnName of Object.keys(table.modifiedColumns)) {
                const [orgColumn, newColumn] = table.modifiedColumns[columnName];

                // change type
                if (orgColumn.type !== newColumn.type || orgColumn.length !== newColumn.length) {
                    let type = newColumn.id ? 'serial' : newColumn.type;
                    if (newColumn.length > 0) {
                        type += `(${newColumn.length})`;
                    }
                    query.push(`ALTER TABLE`);
                    query.push(`    "${tableName}"`);
                    query.push(`ALTER COLUMN "${columnName}" TYPE ${type};`);
                }

                // not null
                if (!newColumn.pk && orgColumn.notNull !== newColumn.notNull) {
                    query.push(`ALTER TABLE`);
                    query.push(`    "${tableName}"`);
                    query.push(`ALTER COLUMN "${columnName}" ${(newColumn.notNull ? 'SET NOT NULL' : 'DROP NOT NULL')};`);
                }

                // default
                if ((orgColumn.default + '').toLowerCase() !== (newColumn.default + '').toLowerCase()) {
                    if (newColumn.default) {
                        query.push(`ALTER TABLE`);
                        query.push(`    "${tableName}"`);
                        query.push(`ALTER COLUMN "${columnName}" SET DEFAULT ${newColumn.default};`);
                    } else {
                        query.push(`ALTER TABLE`);
                        query.push(`    "${tableName}"`);
                        query.push(`ALTER COLUMN "${columnName}" DROP DEFAULT`);
                    }
                }

                if (orgColumn.check !== newColumn.check) {
                    // drop old check
                    if (orgColumn.defaultName) {
                        query.push(`ALTER TABLE`);
                        query.push(`    "${tableName}"`);
                        query.push(`DROP CONSTRAINT`);
                        query.push(`    "${orgColumn.defaultName}";`);
                    }
                    // add new check
                    if (newColumn.check) {
                        query.push(`ALTER TABLE`);
                        query.push(`    "${tableName}"`);
                        query.push(`ADD CHECK(${newColumn.check});`);
                    }
                }

                // foreign key
                const orgFkName = Object.keys(orgColumn.fk || {});
                const newFkName = Object.keys(newColumn.fk || {});
                for (const fkName of distinct(orgFkName, newFkName)) {
                    if (orgFkName.indexOf(fkName) === -1) {
                        const fk = newColumn.fk[fkName];
                        createFkQuery.push(DbPostgres.createAlterForeignKey(fkName, tableName, columnName, fk.table, fk.column, fk.update, fk.delete));
                        continue;
                    }

                    if (newFkName.indexOf(fkName) === -1) {

                        dropFkQuery.push(`ALTER TABLE`);
                        dropFkQuery.push(`    "${tableName}"`);
                        dropFkQuery.push(`DROP CONSTRAINT "${fkName}";`);

                        continue;
                    }

                    if ((orgColumn.fk[fkName].update !== newColumn.fk[fkName].update) ||
                        (orgColumn.fk[fkName].delete !== newColumn.fk[fkName].delete) ||
                        (orgColumn.fk[fkName].table !== newColumn.fk[fkName].table) ||
                        (orgColumn.fk[fkName].column !== newColumn.fk[fkName].column)) {

                        dropFkQuery.push(`ALTER TABLE`);
                        dropFkQuery.push(`    "${tableName}"`);
                        dropFkQuery.push(`DROP CONSTRAINT "${fkName}";`);

                        const fk = newColumn.fk[fkName];
                        createFkQuery.push(DbPostgres.createAlterForeignKey(fkName, tableName, columnName, fk.table, fk.column, fk.update, fk.delete));
                    }
                }
            }

            // drop columns
            for (const columnName of table.deletedColumnName) {
                query.push(`ALTER TABLE`);
                query.push(`    "${tableName}"`);
                query.push(`DROP COLUMN "${columnName}";`);
            }

            // create index
            for (const indexName of Object.keys(table.addedIndexes)) {
                const index = table.addedIndexes[indexName];
                query.push(`CREATE`);
                query.push(`    ${(index.unique ? 'UNIQUE ' : '')}INDEX "${indexName}"`);
                query.push(`ON`);
                query.push(`    "${tableName}" (${Object.keys(index.columns).map(c => `"${c}"`).join(',')});`);
            }

            // modify index
            for (const indexName of Object.keys(table.modifiedIndexes)) {
                const [, index] = table.modifiedIndexes[indexName];

                query.push(`DROP INDEX "${indexName}";`);

                query.push(`CREATE`);
                query.push(`    ${(index.unique ? 'UNIQUE ' : '')}INDEX "${indexName}"`);
                query.push(`ON`);
                query.push(`    "${tableName}" (${Object.keys(index.columns).map(c => `"${c}"`).join(',')});`);
            }

            // drop index
            for (const indexName of table.deletedIndexNames) {
                query.push(`DROP INDEX "${indexName}";`);
            }

        }

        // drop table
        if(dropTable) {
            for (const tableName of diff.deletedTableNames) {
                query.push(`DROP TABLE "${tableName}" CASCADE;`);
            }
        }

        const execQuery = dropFkQuery.join('\n') + '\n' + query.join('\n') + '\n' +  createFkQuery.join('\n');
        console.log(execQuery);
        if (query.length > 0 || createFkQuery.length > 0 || dropFkQuery.length > 0) {
            if (!queryOnly) {
                await this.client.query('BEGIN');
                await this.client.query(execQuery);
                await this.client.query('COMMIT');
            }
            return execQuery;
        } else {
            return null;
        }

        

    }

    /**
     * execute query
     * @param {string} query
     * @returns {Promise<QueryResult>}
     */
    public async exec(query: string) {
        const res = await this.client.query(query);
        return res;
    }

    /**
     *
     * @param {{[key: string]: DbTable}} tables
     * @returns {string}
     */
    private createQuery(tables: { [key: string]: DbTable }) {
        const query: string[] = [];
        for (const tableName of Object.keys(tables)) {
            const table = tables[tableName];

            query.push(`CREATE TABLE ${tableName}(`);

            const columnQuery: string[] = [];
            const pk: string[] = [];
            for (const columnName of Object.keys(table.columns)) {
                const column = table.columns[columnName];
                if (column.id) {
                    column.notNull = true;
                    column.type = 'serial';
                }

                const notNull = column.notNull ? ' NOT NULL ' : '';
                const check = column.check ? ` CHECK(${column.check}) ` : '';
                const def = column.default ? ` DEFAULT ${column.default} ` : '';
                const type = column.type + (column.length > 0 ? `(${column.length})` : '');

                columnQuery.push(`    ${columnName} ${type}${notNull}${check}${def}`);
                if (column.pk || column.id) {
                    pk.push(columnName);
                }
            }
            query.push(columnQuery.join(',\n') + (pk.length > 0 ? ',' : ''));

            if (pk.length > 0) {
                query.push(`    CONSTRAINT PK_${tableName} PRIMARY KEY `);
                query.push('    (');
                const pkQuery: string[] = [];
                pk.forEach(p => {
                    pkQuery.push(`        ${p}`);
                });
                query.push(pkQuery.join(',\n'));
                query.push('    )');
            }
            query.push(');');

            for (const indexName in tables[tableName].indexes) {
                const index = tables[tableName].indexes[indexName];
                const indexColumns = [];
                for (const c in index.columns) {
                    indexColumns.push(c);
                }
                query.push(`CREATE ${(index.unique ? 'UNIQUE ' : '')}INDEX ${indexName} ON ${tableName}(`);
                query.push('    ' + indexColumns.join(','));
                query.push(');');
            }

        }

        // foregin key
        for (const tableName of Object.keys(tables)) {
            const table = tables[tableName];
            for (const columnName of Object.keys(table.columns).filter(c => table.columns[c].fk)) {
                for (const fkName of Object.keys(table.columns[columnName].fk)) {
                    const fk = table.columns[columnName].fk[fkName];
                    query.push(DbPostgres.createAlterForeignKey(fkName, tableName, columnName, fk.table, fk.column, fk.update, fk.delete));
                }
            }
        }

        return query.join('\n');

    }

    private static createAlterForeignKey(name: string, table: string, column: string, targetTable: string, targetColumn: string, onupdate: string, ondelete: string) {

        if (onupdate) {
            onupdate = ` ON UPDATE ${onupdate} `;
        }

        if (ondelete) {
            ondelete = ` ON DELETE ${ondelete} `;
        }

        return `
            ALTER TABLE 
                "${table}" 
            ADD CONSTRAINT "${name}" FOREIGN KEY ("${column}") REFERENCES "${targetTable}"("${targetColumn}")${onupdate || ''}${ondelete || ''};`;
    }
}
