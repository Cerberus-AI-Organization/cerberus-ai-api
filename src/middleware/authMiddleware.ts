import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import '../types/express'; // ensures global Express.Request augmentation is loaded

const JWT_SECRET = process.env.JWT_SECRET!;

export const authenticateToken = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ message: 'No token provided' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ message: 'Invalid token' });
        }

        req.user = user as { id: number; role: string };
        next();
    });
};
