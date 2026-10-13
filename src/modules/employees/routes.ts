import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool';
import { audit } from '../../lib/audit';
import { notFound, badRequest } from '../../lib/errors';
import { koboToNaira, nairaToKobo } from '../../lib/money';
import { authenticate, requireRole } from '../../middleware/auth';
import { parse, wrap } from '../../middleware/errors';

const idParam = z.object({ id: z.string().uuid() });

const base = {
  fullName: z.string().trim().min(2).max(120),
  email: z.string().email(),
  // Naira, at most 2 decimal places.
  salary: z.number().positive().max(1_000_000_000).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'Max 2 decimal places'),
  bankCode: z.string().regex(/^\d{3,6}$/, 'Bank code must be 3 to 6 digits'),
  bankName: z.string().max(120).optional(),
  accountNumber: z.string().regex(/^\d{10}$/, 'Account number must be 10 digits'),
};
const createSchema = z.object(base);
const updateSchema = z.object(base).partial().refine((o) => Object.keys(o).length > 0, 'Provide at least one field');

const COLUMNS: Record<string, string> = {
  fullName: 'full_name',
  email: 'email',
  bankCode: 'bank_code',
  bankName: 'bank_name',
  accountNumber: 'account_number',
};

interface Row {
  id: string;
  employee_code: string;
  full_name: string;
  email: string;
  salary_kobo: string;
  bank_code: string;
  bank_name: string | null;
  account_number: string;
  is_active: boolean;
}

function present(row: Row, canSeeBankDetails: boolean) {
  return {
    id: row.id,
    employeeCode: row.employee_code,
    fullName: row.full_name,
    email: row.email,
    salary: koboToNaira(Number(row.salary_kobo)),
    bankCode: row.bank_code,
    bankName: row.bank_name,
    // Read-only users only ever see the last four digits.
    accountNumber: canSeeBankDetails ? row.account_number : `******${row.account_number.slice(-4)}`,
    isActive: row.is_active,
  };
}

export function employeesRouter() {
  const router = Router();
  const canManage = requireRole('PAYROLL_MANAGER');
  router.use(authenticate);
  const full = (role: string) => role === 'ADMIN' || role === 'PAYROLL_MANAGER';

  router.post(
    '/',
    canManage,
    wrap(async (req, res) => {
      const b = parse(createSchema, req.body);
      const { rows } = await query<Row>(
        `INSERT INTO employees (employee_code, full_name, email, salary_kobo, bank_code, bank_name, account_number)
         VALUES ('EMP-' || lpad(nextval('employee_code_seq')::text, 4, '0'), $1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [b.fullName, b.email.toLowerCase(), nairaToKobo(b.salary), b.bankCode, b.bankName ?? null, b.accountNumber],
      );
      await audit(req.user!.id, 'employee.create', 'employee', rows[0]!.id);
      res.status(201).json({ data: present(rows[0]!, true) });
    }),
  );

  router.get(
    '/',
    wrap(async (req, res) => {
      const { rows } = await query<Row>('SELECT * FROM employees WHERE is_active = TRUE ORDER BY created_at DESC');
      res.json({ data: rows.map((r) => present(r, full(req.user!.role))) });
    }),
  );

  router.get(
    '/:id',
    wrap(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const { rows } = await query<Row>('SELECT * FROM employees WHERE id = $1 AND is_active = TRUE', [id]);
      if (!rows[0]) throw notFound('Employee not found');
      res.json({ data: present(rows[0], full(req.user!.role)) });
    }),
  );

  router.patch(
    '/:id',
    canManage,
    wrap(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const b = parse(updateSchema, req.body);

      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [key, column] of Object.entries(COLUMNS)) {
        const value = (b as Record<string, unknown>)[key];
        if (value !== undefined) {
          values.push(key === 'email' ? String(value).toLowerCase() : value);
          sets.push(`${column} = $${values.length}`);
        }
      }
      if (b.salary !== undefined) {
        values.push(nairaToKobo(b.salary));
        sets.push(`salary_kobo = $${values.length}`);
      }
      if (!sets.length) throw badRequest('Nothing to update');

      values.push(id);
      const { rows } = await query<Row>(
        `UPDATE employees SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} AND is_active = TRUE RETURNING *`,
        values,
      );
      if (!rows[0]) throw notFound('Employee not found');
      await audit(req.user!.id, 'employee.update', 'employee', id, { fields: Object.keys(b) });
      res.json({ data: present(rows[0], true) });
    }),
  );

  // Soft delete: past payrolls keep pointing at the employee.
  router.delete(
    '/:id',
    canManage,
    wrap(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const { rowCount } = await query('UPDATE employees SET is_active = FALSE, updated_at = now() WHERE id = $1 AND is_active = TRUE', [id]);
      if (!rowCount) throw notFound('Employee not found');
      await audit(req.user!.id, 'employee.deactivate', 'employee', id);
      res.status(204).end();
    }),
  );

  return router;
}
