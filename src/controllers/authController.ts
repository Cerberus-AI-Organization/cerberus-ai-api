import {Request, Response} from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import {pool} from '../core/database';
import {User} from '../types/user';

const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_EXPIRY = '14d';

export const login = async (req: Request, res: Response) => {
  const {email, password} = req.body;

  try {
    const result = await pool.query<User>('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({message: 'Invalid email or password'});
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({message: 'Invalid email or password'});
    }

    const token = jwt.sign(
      {id: user.id, role: user.role},
      JWT_SECRET,
      {expiresIn: JWT_EXPIRY}
    );

    const userData = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    }

    res.json({user: userData,token: token});
  } catch (err) {
    console.error(err);
    res.status(500).json({message: 'Something went wrong'});
  }
};

export const loginWithToken = async (req: Request, res: Response) => {
  const user = (req as any).user;

  try {
    const result = await pool.query<User>(
      'SELECT id, name, email, role FROM users WHERE id = $1',
      [user.id]
    );

    const userData = result.rows[0];
    if (!userData) {
      return res.status(404).json({error: 'User not found'});
    }

    const newToken = jwt.sign(
      {id: user.id, role: user.role},
      JWT_SECRET,
      {expiresIn: JWT_EXPIRY}
    );

    res.json({user: userData, token: newToken});
  } catch (err) {
    console.error(err);
    res.status(500).json({error: 'Something went wrong'});
  }
};
