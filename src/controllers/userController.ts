import { Request, Response } from 'express';
import { pool } from '../core/database';
import bcrypt from 'bcrypt';
import { User } from '../types/user';

// GET users
export const getUsers = async (req: Request, res: Response) => {
    const user = (req as any).user;

    try {
        if (user.role === 'admin') {
            const result = await pool.query<User>('SELECT id, name, email, role FROM users');
            return res.json(result.rows);
        } else {
            const result = await pool.query<User>(
                'SELECT id, name, email, role FROM users WHERE id=$1',
                [user.id]
            );
            return res.json(result.rows[0]);
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error fetching users' });
    }
};

// ADD user (only admin)
export const addUser = async (req: Request, res: Response) => {
    const currentUser = (req as any).user;
    if (currentUser.role !== 'admin') {
        return res.status(403).json({ message: 'Only admins can add users' });
    }

    const { name, email, password, role } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({ message: 'Name, email and password required' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query<User>(
            'INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
            [name, email, hashedPassword, role || 'user']
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error adding user' });
    }
};

// UPDATE user
export const updateUser = async (req: Request, res: Response) => {
    const currentUser = (req as any).user;
    const { id } = req.params;
    const { name, email, password, role } = req.body;

    // user může update jen sám sebe, admin kohokoliv
    if (currentUser.role !== 'admin' && parseInt(id) !== currentUser.id) {
        return res.status(403).json({ message: 'Not authorized to update this user' });
    }

    try {
        let query = 'UPDATE users SET name=$1, email=$2';
        const values: any[] = [name, email];
        let i = 3;

        if (password) {
            const hashedPassword = await bcrypt.hash(password, 10);
            query += `, password=$${i++}`;
            values.push(hashedPassword);
        }

        if (currentUser.role === 'admin' && role) {
            query += `, role=$${i++}`;
            values.push(role);
        }

        query += ` WHERE id=$${i} RETURNING id, name, email, role`;
        values.push(id);

        const result = await pool.query<User>(query, values);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error updating user' });
    }
};

// DELETE user (only admin)
export const deleteUser = async (req: Request, res: Response) => {
    const currentUser = (req as any).user;
    if (currentUser.role !== 'admin') {
        return res.status(403).json({ message: 'Only admins can delete users' });
    }

    const { id } = req.params;

    try {
        const result = await pool.query('DELETE FROM users WHERE id=$1 RETURNING id', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'User not found' });
        }
        res.json({ message: 'User deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error deleting user' });
    }
};
